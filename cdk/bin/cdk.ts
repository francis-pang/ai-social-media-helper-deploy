#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { StorageStack } from '../lib/storage-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendPipelineStack } from '../lib/frontend-pipeline-stack';
import { BackendPipelineStack } from '../lib/backend-pipeline-stack';
import { OperationsStack } from '../lib/operations-stack';
import { WebhookStack } from '../lib/webhook-stack';

const app = new cdk.App();

// All resources use 'AiSocialMedia' prefix to match scoped IAM policies (DDR-023).
// S3 buckets use 'ai-social-media-' prefix (lowercase with hyphens per S3 naming rules).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// CodeStar connection ARN — read from environment or use default (DDR-028 Problem 15)
const codeStarConnectionArn = process.env.CODESTAR_CONNECTION_ARN
  || 'arn:aws:codeconnections:us-east-1:123456789012:connection/YOUR_CONNECTION_ID';

// Optional context variables
const enableMetricArchive = app.node.tryGetContext('enableMetricArchive') === 'true';

// =========================================================================
// 1. Storage (STATEFUL — DDR-045: all S3 buckets + DynamoDB in one stack)
// =========================================================================
// This stack is termination-protected and rarely changes. All stateful
// resources live here so stateless stacks can be freely destroyed/redeployed
// without orphaning S3 buckets.
const storage = new StorageStack(app, 'AiSocialMediaStorage', {
  env,
  enableMetricArchive,
});

// =========================================================================
// 2. Backend (STATELESS): 5 Lambdas + API Gateway + Cognito + 2 ECR repos + 2 Step Functions (DDR-035)
// =========================================================================
const backend = new BackendStack(app, 'AiSocialMediaBackend', {
  env,
  mediaBucket: storage.mediaBucket,
  sessionsTable: storage.sessionsTable,
});
backend.addDependency(storage);

// =========================================================================
// 3. Frontend (STATELESS): CloudFront with OAC, security headers, origin-verify, /api/* proxy
// =========================================================================
// S3 bucket name passed as string to avoid cross-stack OAC cycle (DDR-045).
// FrontendStack imports the bucket by name and manages the OAC bucket policy locally.
const frontend = new FrontendStack(app, 'AiSocialMediaFrontend', {
  env,
  apiEndpoint: backend.httpApi.apiEndpoint,
  originVerifySecret: cdk.Fn.select(2, cdk.Fn.split('/', backend.stackId)),
  frontendBucketName: storage.frontendBucket.bucketName,
});
frontend.addDependency(backend);
frontend.addDependency(storage); // Bucket must exist before CloudFront OAC (DDR-045)

// =========================================================================
// 4. Frontend Pipeline (STATELESS): Preact SPA build -> S3 + CloudFront invalidation (DDR-035)
// =========================================================================
// Artifact bucket comes from StorageStack (DDR-045)
const frontendPipeline = new FrontendPipelineStack(app, 'AiSocialMediaFrontendPipeline', {
  env,
  frontendBucket: storage.frontendBucket,
  distribution: frontend.distribution,
  codeStarConnectionArn,
  cognitoUserPoolId: backend.userPool.userPoolId,
  cognitoClientId: backend.userPoolClient.userPoolClientId,
  artifactBucket: storage.feArtifactBucket,
});
frontendPipeline.addDependency(frontend);

// =========================================================================
// 5. Webhook (STATELESS): Dedicated CloudFront + API Gateway + Lambda for Meta webhooks (DDR-044)
// =========================================================================
const webhook = new WebhookStack(app, 'AiSocialMediaWebhook', { env });

// =========================================================================
// 6. Backend Pipeline (STATELESS): 6 Docker builds -> 6 Lambda updates (DDR-035, DDR-041, DDR-044)
// =========================================================================
// Artifact bucket comes from StorageStack (DDR-045)
const backendPipeline = new BackendPipelineStack(app, 'AiSocialMediaBackendPipeline', {
  env,
  lightEcrRepo: backend.lightEcrRepo,
  heavyEcrRepo: backend.heavyEcrRepo,
  publicLightRepoName: backend.publicLightEcrRepo.repositoryName!,
  publicHeavyRepoName: backend.publicHeavyEcrRepo.repositoryName!,
  apiHandler: backend.apiHandler,
  thumbnailProcessor: backend.thumbnailProcessor,
  selectionProcessor: backend.selectionProcessor,
  enhancementProcessor: backend.enhancementProcessor,
  videoProcessor: backend.videoProcessor,
  webhookEcrRepo: webhook.webhookEcrRepo,
  webhookHandler: webhook.webhookHandler,
  codeStarConnectionArn,
  artifactBucket: storage.beArtifactBucket,
});
backendPipeline.addDependency(backend);
backendPipeline.addDependency(webhook);

// =========================================================================
// 7. Operations (STATELESS): Alarms, dashboard, log archival, X-Ray, metric filters
// =========================================================================
// Log/metrics archive buckets come from StorageStack (DDR-045)
const operations = new OperationsStack(app, 'AiSocialMediaOperations', {
  env,
  lambdas: [
    { id: 'ApiHandler', fn: backend.apiHandler },
    { id: 'ThumbnailProcessor', fn: backend.thumbnailProcessor },
    { id: 'SelectionProcessor', fn: backend.selectionProcessor },
    { id: 'EnhancementProcessor', fn: backend.enhancementProcessor },
    { id: 'VideoProcessor', fn: backend.videoProcessor },
  ],
  httpApi: backend.httpApi,
  selectionPipeline: backend.selectionPipeline,
  enhancementPipeline: backend.enhancementPipeline,
  sessionsTable: storage.sessionsTable,
  mediaBucket: storage.mediaBucket,
  alertEmail: app.node.tryGetContext('alertEmail'),
  logArchiveBucket: storage.logArchiveBucket,
  metricsArchiveBucket: storage.metricsArchiveBucket,
});
operations.addDependency(backend);
operations.addDependency(storage);

app.synth();
