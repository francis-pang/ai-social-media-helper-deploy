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

// 1. Storage: S3 media bucket (24h lifecycle) + DynamoDB session state (DDR-035)
const storage = new StorageStack(app, 'AiSocialMediaStorage', { env });

// 2. Backend: 5 Lambdas + API Gateway + Cognito + 2 ECR repos + 2 Step Functions (DDR-035)
const backend = new BackendStack(app, 'AiSocialMediaBackend', {
  env,
  mediaBucket: storage.mediaBucket,
  sessionsTable: storage.sessionsTable,
});
backend.addDependency(storage);

// 3. Frontend: S3 + CloudFront with OAC, security headers, origin-verify, and /api/* proxy
const frontend = new FrontendStack(app, 'AiSocialMediaFrontend', {
  env,
  apiEndpoint: backend.httpApi.apiEndpoint,
  originVerifySecret: cdk.Fn.select(2, cdk.Fn.split('/', backend.stackId)),
});
frontend.addDependency(backend);

// 4. Frontend Pipeline: Preact SPA build -> S3 + CloudFront invalidation (DDR-035)
const frontendPipeline = new FrontendPipelineStack(app, 'AiSocialMediaFrontendPipeline', {
  env,
  frontendBucket: frontend.frontendBucket,
  distribution: frontend.distribution,
  codeStarConnectionArn,
  cognitoUserPoolId: backend.userPool.userPoolId,
  cognitoClientId: backend.userPoolClient.userPoolClientId,
});
frontendPipeline.addDependency(frontend);

// 5. Webhook: Dedicated CloudFront + API Gateway + Lambda for Meta webhooks (DDR-044)
const webhook = new WebhookStack(app, 'AiSocialMediaWebhook', { env });

// 6. Backend Pipeline: 6 Docker builds -> 6 Lambda updates (DDR-035, DDR-041, DDR-044)
//    2 images -> ECR Private (API, Selection), 3 images -> ECR Public (Enhancement, Thumbnail, Video)
//    1 image -> ECR Private Webhook
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
});
backendPipeline.addDependency(backend);
backendPipeline.addDependency(webhook);

// 7. Operations: Alarms, dashboard, log archival, X-Ray, metric filters
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
  enableMetricArchive: app.node.tryGetContext('enableMetricArchive') === 'true',
});
operations.addDependency(backend);
operations.addDependency(storage);

app.synth();
