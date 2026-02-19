import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  /** CloudFront distribution domain for S3 CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
  /** Enable long-term metric archival bucket (optional, pass via -c enableMetricArchive=true) */
  enableMetricArchive?: boolean;
  /** ECR heavy repository for MediaProcess Lambda image (DDR-061) */
  heavyEcrRepo: ecr.IRepository;
}

/**
 * StorageStack is the **stateful** stack — it owns every persistent data store
 * so that stateless stacks (compute, pipelines, monitoring) can be destroyed
 * and redeployed without orphaning S3 buckets or DynamoDB tables (DDR-045).
 *
 * Resources:
 * 1. S3 bucket for ephemeral media uploads (24h auto-expiration)
 * 2. DynamoDB table for multi-step session state (DDR-035)
 * 3. S3 bucket for frontend assets (CloudFront OAC)
 * 4. S3 bucket for log archival (Deep Archive lifecycle, RETAIN)
 * 5. S3 bucket for metric archival (optional, RETAIN)
 * 6. S3 bucket for backend pipeline artifacts (7d lifecycle)
 * 7. S3 bucket for frontend pipeline artifacts (7d lifecycle)
 *
 * Termination protection is enabled to prevent accidental deletion (DDR-045).
 */
export class StorageStack extends cdk.Stack {
  public readonly mediaBucket: s3.Bucket;
  public readonly sessionsTable: dynamodb.Table;
  public readonly fileProcessingTable: dynamodb.Table;
  public readonly mediaProcessProcessor: lambda.DockerImageFunction;
  public readonly frontendBucket: s3.Bucket;
  public readonly logArchiveBucket: s3.Bucket;
  public readonly metricsArchiveBucket?: s3.Bucket;
  public readonly beArtifactBucket: s3.Bucket;
  public readonly feArtifactBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StorageStackProps) {
    super(scope, id, {
      ...props,
      terminationProtection: true, // DDR-045: protect stateful resources
    });

    // Restrict S3 CORS to CloudFront domain if known (DDR-028 Problem 9)
    const allowedOrigins = props?.cloudFrontDomain
      ? [`https://${props.cloudFrontDomain}`]
      : ['https://*.cloudfront.net']; // Fallback: allow any CloudFront distribution

    // =========================================================================
    // 1. Media Uploads Bucket (ephemeral, 24h lifecycle)
    // =========================================================================
    this.mediaBucket = new s3.Bucket(this, 'MediaUploads', {
      bucketName: `ai-social-media-uploads-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(1),
          id: 'expire-uploads-24h',
        },
      ],
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins,
          // Expose ETag so the browser can read it from chunk upload responses
          // (required for S3 CompleteMultipartUpload — DDR-054).
          exposedHeaders: ['ETag'],
          maxAge: 3600,
        },
      ],
    });

    // =========================================================================
    // 2. DynamoDB Session State Table (DDR-035, DDR-039)
    // =========================================================================
    // Single-table design: all session data co-located under SESSION#{sessionId}.
    // Query(PK = SESSION#abc) retrieves the entire session state in one call.
    // TTL auto-deletes records after 24 hours (matches S3 media expiration).
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'media-selection-sessions',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // 2b. File Processing Table (DDR-061: per-file triage processing results)
    // =========================================================================
    // Dedicated table for ephemeral per-file processing results during triage.
    // Separate from sessions table for: data isolation, zero write contention
    // between concurrent MediaProcess Lambda invocations, independent scaling,
    // and shorter TTL (4 hours vs 24 hours for sessions).
    this.fileProcessingTable = new dynamodb.Table(this, 'FileProcessingTable', {
      tableName: 'media-file-processing',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING }, // {sessionId}#{jobId}
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },       // {filename}
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // 2c. MediaProcess Lambda (DDR-061: S3 event-driven per-file processing)
    // =========================================================================
    // Lives in StorageStack to avoid cyclic dependency: S3 event notification
    // requires bucket and Lambda in same stack (bucket -> Lambda creates Storage -> Backend cycle).
    const useLocalImages = this.node.tryGetContext('localImages') === 'true';
    const lambdaCodeRoot = path.resolve(__dirname, '..', '..', '..', '..', 'ai-social-media-helper');
    const imageCode = (
      repo: ecr.IRepository,
      tag: string,
      localDir: string,
    ): lambda.DockerImageCode =>
      useLocalImages
        ? lambda.DockerImageCode.fromImageAsset(path.join(lambdaCodeRoot, localDir))
        : lambda.DockerImageCode.fromEcr(repo, { tagOrDigest: tag });

    this.mediaProcessProcessor = new lambda.DockerImageFunction(this, 'MediaProcessProcessor', {
      description: 'Per-file media processing — validates, converts, generates thumbnails, triggered by S3 events (DDR-061)',
      code: imageCode(props!.heavyEcrRepo, 'mediaprocess-latest', 'media-process-lambda'),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(4096),
      environment: {
        MEDIA_BUCKET_NAME: this.mediaBucket.bucketName,
        DYNAMO_TABLE_NAME: this.sessionsTable.tableName,
        FILE_PROCESSING_TABLE_NAME: this.fileProcessingTable.tableName,
      },
    });
    this.mediaBucket.grantReadWrite(this.mediaProcessProcessor);
    this.mediaBucket.grantDelete(this.mediaProcessProcessor);
    this.sessionsTable.grantReadWriteData(this.mediaProcessProcessor);
    this.fileProcessingTable.grantReadWriteData(this.mediaProcessProcessor);

    // S3 event notification: trigger MediaProcess Lambda on ObjectCreated (DDR-061)
    // MediaProcess Lambda filters keys internally (skips /thumbnails/, /processed/, /compressed/)
    this.mediaBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(this.mediaProcessProcessor),
    );

    // =========================================================================
    // 3. Frontend Assets Bucket (private, OAC-only access — DDR-045: moved from FrontendStack)
    // =========================================================================
    this.frontendBucket = new s3.Bucket(this, 'FrontendAssets', {
      bucketName: `ai-social-media-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // =========================================================================
    // 4. Log Archive Bucket (Deep Archive lifecycle, RETAIN — DDR-045: moved from OperationsStack)
    // =========================================================================
    this.logArchiveBucket = new s3.Bucket(this, 'LogArchive', {
      bucketName: `ai-social-media-logs-archive-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'info-and-above-tiering',
          prefix: 'logs/info-and-above/',
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          expiration: cdk.Duration.days(395), // 30 + 365
        },
        {
          id: 'debug-tiering',
          prefix: 'logs/debug/',
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(14),
            },
          ],
          expiration: cdk.Duration.days(379), // 14 + 365
        },
      ],
    });

    // =========================================================================
    // 5. Metrics Archive Bucket (optional, RETAIN — DDR-045: moved from OperationsStack)
    // =========================================================================
    if (props?.enableMetricArchive) {
      this.metricsArchiveBucket = new s3.Bucket(this, 'MetricsArchive', {
        bucketName: `ai-social-media-metrics-archive-${this.account}`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            id: 'metrics-tiering',
            transitions: [
              {
                storageClass: s3.StorageClass.ONE_ZONE_INFREQUENT_ACCESS,
                transitionAfter: cdk.Duration.days(90),
              },
              {
                storageClass: s3.StorageClass.DEEP_ARCHIVE,
                transitionAfter: cdk.Duration.days(365),
              },
            ],
          },
        ],
      });
    }

    // =========================================================================
    // 6. Backend Pipeline Artifacts Bucket (DDR-045: moved from BackendPipelineStack)
    // =========================================================================
    this.beArtifactBucket = new s3.Bucket(this, 'BackendArtifacts', {
      bucketName: `ai-social-media-be-artifacts-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(7),
          id: 'expire-artifacts-7d',
        },
      ],
    });

    // =========================================================================
    // 7. Frontend Pipeline Artifacts Bucket (DDR-045: moved from FrontendPipelineStack)
    // =========================================================================
    this.feArtifactBucket = new s3.Bucket(this, 'FrontendArtifacts', {
      bucketName: `ai-social-media-fe-artifacts-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(7),
          id: 'expire-artifacts-7d',
        },
      ],
    });

    // =========================================================================
    // Tag CDK custom resource provider (DDR-049: cost tracking completeness)
    // =========================================================================
    // The autoDeleteObjects custom resource provider uses CfnResource (not typed
    // L1 constructs), so cdk.Tags.of(app) doesn't reach its Lambda and Role.
    const autoDeleteProvider = this.node.tryFindChild(
      'Custom::S3AutoDeleteObjectsCustomResourceProvider',
    );
    if (autoDeleteProvider) {
      const handler = autoDeleteProvider.node.tryFindChild('Handler') as cdk.CfnResource | undefined;
      if (handler) {
        handler.addPropertyOverride('Tags', [{ Key: 'Project', Value: 'ai-social-media-helper' }]);
      }
      const role = autoDeleteProvider.node.tryFindChild('Role') as cdk.CfnResource | undefined;
      if (role) {
        role.addPropertyOverride('Tags', [{ Key: 'Project', Value: 'ai-social-media-helper' }]);
      }
    }

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      description: 'Media uploads S3 bucket name',
    });

    new cdk.CfnOutput(this, 'MediaBucketArn', {
      value: this.mediaBucket.bucketArn,
      description: 'Media uploads S3 bucket ARN',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: this.sessionsTable.tableName,
      description: 'DynamoDB sessions table name',
    });

    new cdk.CfnOutput(this, 'SessionsTableArn', {
      value: this.sessionsTable.tableArn,
      description: 'DynamoDB sessions table ARN',
    });

    new cdk.CfnOutput(this, 'FileProcessingTableName', {
      value: this.fileProcessingTable.tableName,
      description: 'DynamoDB file processing table name (DDR-061)',
    });

    new cdk.CfnOutput(this, 'FileProcessingTableArn', {
      value: this.fileProcessingTable.tableArn,
      description: 'DynamoDB file processing table ARN (DDR-061)',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.frontendBucket.bucketName,
      description: 'Frontend assets S3 bucket name',
    });

    new cdk.CfnOutput(this, 'LogArchiveBucketName', {
      value: this.logArchiveBucket.bucketName,
      description: 'S3 bucket for archived logs (queryable via Athena)',
    });

    new cdk.CfnOutput(this, 'BeArtifactBucketName', {
      value: this.beArtifactBucket.bucketName,
      description: 'Backend pipeline artifacts S3 bucket name',
    });

    new cdk.CfnOutput(this, 'FeArtifactBucketName', {
      value: this.feArtifactBucket.bucketName,
      description: 'Frontend pipeline artifacts S3 bucket name',
    });
  }
}
