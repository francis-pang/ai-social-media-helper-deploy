import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface ProcessingLambdasProps {
  /** S3 bucket for media uploads */
  mediaBucket: s3.IBucket;
  /** DynamoDB table for session state */
  sessionsTable: dynamodb.ITable;
  /** ECR Private light repository (from RegistryStack) */
  lightEcrRepo: ecr.IRepository;
  /** ECR Private heavy repository (from RegistryStack) */
  heavyEcrRepo: ecr.IRepository;
  /** Origin-verify shared secret for API Lambda (DDR-028) */
  originVerifySecret: string;
}

/**
 * ProcessingLambdas creates all 9 Lambda functions and applies IAM permissions (DDR-035, DDR-053).
 *
 * Lambda inventory:
 * - API: HTTP handler (256 MB, 30s)
 * - Triage: Step Functions triage pipeline (2 GB, 10 min)
 * - Description: Async caption generation (2 GB, 5 min)
 * - Download: Async ZIP bundle creation (2 GB, 10 min)
 * - Publish: Step Functions publish pipeline (256 MB, 5 min)
 * - Thumbnail: Per-file thumbnail generation (512 MB, 2 min)
 * - Selection: AI media selection (4 GB, 15 min)
 * - Enhancement: Per-photo AI editing + feedback (2 GB, 5 min)
 * - Video: Per-video ffmpeg enhancement (4 GB, 15 min)
 *
 * IAM follows least privilege (DDR-053):
 * - All Lambdas: S3 read/write/delete, DynamoDB CRUD
 * - AI Lambdas: SSM read for Gemini API key
 * - Instagram Lambdas (API + Publish): SSM read for Instagram credentials
 * - API Lambda: lambda:InvokeFunction for async dispatch
 */
export class ProcessingLambdas extends Construct {
  public readonly apiHandler: lambda.DockerImageFunction;
  public readonly triageProcessor: lambda.DockerImageFunction;
  public readonly descriptionProcessor: lambda.DockerImageFunction;
  public readonly downloadProcessor: lambda.DockerImageFunction;
  public readonly publishProcessor: lambda.DockerImageFunction;
  public readonly thumbnailProcessor: lambda.DockerImageFunction;
  public readonly selectionProcessor: lambda.DockerImageFunction;
  public readonly enhancementProcessor: lambda.DockerImageFunction;
  public readonly videoProcessor: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: ProcessingLambdasProps) {
    super(scope, id);

    // Shared environment variables for Lambdas that need Gemini
    const sharedEnv = {
      MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
      DYNAMO_TABLE_NAME: props.sessionsTable.tableName,
      SSM_API_KEY_PARAM: '/ai-social-media/prod/gemini-api-key',
    };

    // =====================================================================
    // Lambda Definitions
    // =====================================================================

    // --- 1. API Lambda (256 MB, 30s, ECR Private light) ---
    this.apiHandler = new lambda.DockerImageFunction(this, 'ApiHandler', {
      code: lambda.DockerImageCode.fromEcr(props.lightEcrRepo, { tagOrDigest: 'api-latest' }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      environment: {
        ...sharedEnv,
        ORIGIN_VERIFY_SECRET: props.originVerifySecret,
        SSM_INSTAGRAM_TOKEN_PARAM: '/ai-social-media/prod/instagram-access-token',
        SSM_INSTAGRAM_USER_ID_PARAM: '/ai-social-media/prod/instagram-user-id',
      },
    });

    // --- 2. Triage Lambda (DDR-053: 2 GB, 10 min, ECR Private light) ---
    this.triageProcessor = new lambda.DockerImageFunction(this, 'TriageProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.lightEcrRepo, { tagOrDigest: 'triage-latest' }),
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: sharedEnv,
    });

    // --- 3. Description Lambda (DDR-053: 2 GB, 5 min, ECR Private light) ---
    this.descriptionProcessor = new lambda.DockerImageFunction(this, 'DescriptionProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.lightEcrRepo, { tagOrDigest: 'desc-latest' }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      environment: sharedEnv,
    });

    // --- 4. Download Lambda (DDR-053: 2 GB, 10 min, ECR Private light) ---
    this.downloadProcessor = new lambda.DockerImageFunction(this, 'DownloadProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.lightEcrRepo, { tagOrDigest: 'download-latest' }),
      timeout: cdk.Duration.minutes(10),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: {
        MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
        DYNAMO_TABLE_NAME: props.sessionsTable.tableName,
        // No SSM_API_KEY_PARAM — download-lambda has no AI deps
      },
    });

    // --- 5. Publish Lambda (DDR-053: 256 MB, 5 min, ECR Private light) ---
    this.publishProcessor = new lambda.DockerImageFunction(this, 'PublishProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.lightEcrRepo, { tagOrDigest: 'publish-latest' }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      environment: {
        MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
        DYNAMO_TABLE_NAME: props.sessionsTable.tableName,
        SSM_INSTAGRAM_TOKEN_PARAM: '/ai-social-media/prod/instagram-access-token',
        SSM_INSTAGRAM_USER_ID_PARAM: '/ai-social-media/prod/instagram-user-id',
        // No SSM_API_KEY_PARAM — publish-lambda has no Gemini deps
      },
    });

    // --- 6. Thumbnail Lambda (512 MB, 2 min, ECR Private heavy) ---
    this.thumbnailProcessor = new lambda.DockerImageFunction(this, 'ThumbnailProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.heavyEcrRepo, { tagOrDigest: 'thumb-latest' }),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: sharedEnv,
    });

    // --- 7. Selection Lambda (4 GB, 15 min, ECR Private heavy) ---
    this.selectionProcessor = new lambda.DockerImageFunction(this, 'SelectionProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.heavyEcrRepo, { tagOrDigest: 'select-latest' }),
      timeout: cdk.Duration.minutes(15),
      memorySize: 4096,
      ephemeralStorageSize: cdk.Size.mebibytes(4096),
      environment: sharedEnv,
    });

    // --- 8. Enhancement Lambda (DDR-053: 2 GB, 5 min, ECR Private light) ---
    this.enhancementProcessor = new lambda.DockerImageFunction(this, 'EnhancementProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.lightEcrRepo, { tagOrDigest: 'api-latest' }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: sharedEnv,
    });

    // --- 9. Video Lambda (4 GB, 15 min, ECR Private heavy) ---
    this.videoProcessor = new lambda.DockerImageFunction(this, 'VideoProcessor', {
      code: lambda.DockerImageCode.fromEcr(props.heavyEcrRepo, { tagOrDigest: 'select-latest' }),
      timeout: cdk.Duration.minutes(15),
      memorySize: 4096,
      ephemeralStorageSize: cdk.Size.mebibytes(10240),
      environment: sharedEnv,
    });

    // =====================================================================
    // IAM Permissions (least privilege per Lambda — DDR-035, DDR-053)
    // =====================================================================
    const allLambdas = [
      this.apiHandler,
      this.triageProcessor,
      this.descriptionProcessor,
      this.downloadProcessor,
      this.publishProcessor,
      this.thumbnailProcessor,
      this.selectionProcessor,
      this.enhancementProcessor,
      this.videoProcessor,
    ];

    // All Lambdas: S3 read/write/delete + DynamoDB CRUD
    for (const fn of allLambdas) {
      props.mediaBucket.grantReadWrite(fn);
      props.mediaBucket.grantDelete(fn);
      props.sessionsTable.grantReadWriteData(fn);
    }

    // AI Lambdas: SSM read for Gemini API key (DDR-053: not needed by download/publish)
    const stack = cdk.Stack.of(this);
    const geminiKeyArn = `arn:aws:ssm:${stack.region}:${stack.account}:parameter/ai-social-media/prod/gemini-api-key`;
    const aiLambdas = [
      this.apiHandler,
      this.triageProcessor,
      this.descriptionProcessor,
      this.selectionProcessor,
      this.enhancementProcessor,
      this.videoProcessor,
      this.thumbnailProcessor,
    ];
    for (const fn of aiLambdas) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [geminiKeyArn],
        }),
      );
    }

    // Instagram Lambdas: SSM read for Instagram credentials (DDR-053: only API + Publish)
    for (const fn of [this.apiHandler, this.publishProcessor]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${stack.region}:${stack.account}:parameter/ai-social-media/prod/instagram-access-token`,
            `arn:aws:ssm:${stack.region}:${stack.account}:parameter/ai-social-media/prod/instagram-user-id`,
          ],
        }),
      );
    }

    // API Lambda: permission to invoke domain-specific Lambdas asynchronously (DDR-053)
    this.apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          this.descriptionProcessor.functionArn,
          this.downloadProcessor.functionArn,
          this.enhancementProcessor.functionArn,
        ],
      }),
    );
  }
}
