import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { createProcessingLambda } from './lambda-factory.js';

export interface ProcessingLambdasProps {
  /** S3 bucket for media uploads */
  mediaBucket: s3.IBucket;
  /** DynamoDB table for session state */
  sessionsTable: dynamodb.ITable;
  /** DynamoDB table for per-file processing results (DDR-061) */
  fileProcessingTable: dynamodb.ITable;
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
 * NOTE: This is a plain class (not a CDK Construct) to preserve CloudFormation
 * logical IDs. All resources are created with `scope` as their parent, keeping
 * them at the stack root level. Moving resources into a Construct subtree would
 * change their logical IDs and cause CloudFormation to replace them.
 *
 * Lambda inventory:
 * - API: HTTP handler (256 MB, 30s)
 * - Triage: Step Functions triage pipeline (4 GB, 10 min)
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
    // Local image assets mode (DDR-054: deploy speed Phase 4).
    // Use `-c localImages=true` to build Docker images locally instead of
    // pulling from ECR. This enables `cdk deploy --hotswap` for Lambda code
    // changes and eliminates the separate ECR push step during local dev.
    const useLocalImages = cdk.Stack.of(scope).node.tryGetContext('localImages') === 'true';

    // Helper: pick ECR-based or local Docker image code based on context flag.
    // Local paths are relative to the CDK project root, pointing at the
    // monorepo's Lambda source directories.
    const lambdaCodeRoot = path.resolve(__dirname, '..', '..', '..', '..', 'ai-social-media-helper');
    const imageCode = (
      repo: ecr.IRepository,
      tag: string,
      localDir: string,
    ): lambda.DockerImageCode =>
      useLocalImages
        ? lambda.DockerImageCode.fromImageAsset(path.join(lambdaCodeRoot, localDir))
        : lambda.DockerImageCode.fromEcr(repo, { tagOrDigest: tag });

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
    this.apiHandler = createProcessingLambda(scope, 'ApiHandler', {
      description: 'HTTP API handler — routes requests, dispatches async tasks, reads Instagram credentials',
      code: imageCode(props.lightEcrRepo, 'api-latest', 'api-lambda'),
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

    // --- 2. Triage Lambda (DDR-053: 4 GB, 10 min, ECR Private light) ---
    this.triageProcessor = createProcessingLambda(scope, 'TriageProcessor', {
      description: 'Triage pipeline — uploads media to Gemini, polls file status, runs AI content triage',
      code: imageCode(props.lightEcrRepo, 'triage-latest', 'triage-lambda'),
      timeout: cdk.Duration.minutes(10),
      memorySize: 4096,
      ephemeralStorageSize: cdk.Size.mebibytes(6144),
      environment: sharedEnv,
    });

    // --- 3. Description Lambda (DDR-053: 2 GB, 5 min, ECR Private light) ---
    this.descriptionProcessor = createProcessingLambda(scope, 'DescriptionProcessor', {
      description: 'Caption generation — uses Gemini AI to generate Instagram captions and hashtags',
      code: imageCode(props.lightEcrRepo, 'desc-latest', 'description-lambda'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      environment: sharedEnv,
    });

    // --- 4. Download Lambda (DDR-053: 2 GB, 10 min, ECR Private light) ---
    this.downloadProcessor = createProcessingLambda(scope, 'DownloadProcessor', {
      description: 'Download bundle — packages selected media into a ZIP archive for user download',
      code: imageCode(props.lightEcrRepo, 'download-latest', 'download-lambda'),
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
    this.publishProcessor = createProcessingLambda(scope, 'PublishProcessor', {
      description: 'Publish pipeline — creates Instagram containers, polls video status, publishes posts',
      code: imageCode(props.lightEcrRepo, 'publish-latest', 'publish-lambda'),
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
    this.thumbnailProcessor = createProcessingLambda(scope, 'ThumbnailProcessor', {
      description: 'Thumbnail generation — creates preview thumbnails from photos and video frames via ffmpeg',
      code: imageCode(props.heavyEcrRepo, 'thumb-latest', 'thumbnail-lambda'),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: sharedEnv,
    });

    // --- 7. Selection Lambda (4 GB, 15 min, ECR Private heavy) ---
    this.selectionProcessor = createProcessingLambda(scope, 'SelectionProcessor', {
      description: 'AI media selection — uses Gemini to rank and select the best photos/videos from uploads',
      code: imageCode(props.heavyEcrRepo, 'select-latest', 'selection-lambda'),
      timeout: cdk.Duration.minutes(15),
      memorySize: 4096,
      ephemeralStorageSize: cdk.Size.mebibytes(6144),
      environment: sharedEnv,
    });

    // --- 8. Enhancement Lambda (DDR-053: 2 GB, 5 min, ECR Private light) ---
    this.enhancementProcessor = createProcessingLambda(scope, 'EnhancementProcessor', {
      description: 'Photo enhancement — applies AI-driven edits per photo with user feedback loop via Gemini',
      code: imageCode(props.lightEcrRepo, 'api-latest', 'enhancement-lambda'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: sharedEnv,
    });

    // --- 9. Video Lambda (4 GB, 15 min, ECR Private heavy) ---
    this.videoProcessor = createProcessingLambda(scope, 'VideoProcessor', {
      description: 'Video processing — applies ffmpeg transformations (trim, resize, filters) per video file',
      code: imageCode(props.heavyEcrRepo, 'video-latest', 'video-lambda'),
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

    // Triage Lambda: file processing table read/write (DDR-061 — reads manifest for triage-run, writes for triage-prepare)
    props.fileProcessingTable.grantReadWriteData(this.triageProcessor);
    // API Lambda: file processing table read (DDR-061 — reads per-file statuses for results endpoint)
    props.fileProcessingTable.grantReadData(this.apiHandler);

    // AI Lambdas: SSM read for Gemini API key (DDR-053: not needed by download/publish)
    const stack = cdk.Stack.of(scope);
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
