import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  /** CloudFront distribution domain for S3 CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
  /** Enable long-term metric archival bucket (optional, pass via -c enableMetricArchive=true) */
  enableMetricArchive?: boolean;
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
 * 4. S3 bucket for log archival (Glacier lifecycle, RETAIN)
 * 5. S3 bucket for metric archival (optional, RETAIN)
 * 6. S3 bucket for backend pipeline artifacts (7d lifecycle)
 * 7. S3 bucket for frontend pipeline artifacts (7d lifecycle)
 *
 * Termination protection is enabled to prevent accidental deletion (DDR-045).
 */
export class StorageStack extends cdk.Stack {
  public readonly mediaBucket: s3.Bucket;
  public readonly sessionsTable: dynamodb.Table;
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
    // 4. Log Archive Bucket (tiered lifecycle, RETAIN — DDR-045: moved from OperationsStack)
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
              storageClass: s3.StorageClass.GLACIER,
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
              storageClass: s3.StorageClass.GLACIER,
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
                storageClass: s3.StorageClass.INFREQUENT_ACCESS,
                transitionAfter: cdk.Duration.days(90),
              },
              {
                storageClass: s3.StorageClass.GLACIER,
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
