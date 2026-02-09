#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { StorageStack } from '../lib/storage-stack';
import { RegistryStack } from '../lib/registry-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendPipelineStack } from '../lib/frontend-pipeline-stack';
import { BackendPipelineStack } from '../lib/backend-pipeline-stack';
import { OperationsAlertStack } from '../lib/operations-alert-stack';
import { OperationsMonitoringStack } from '../lib/operations-monitoring-stack';
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

// Metric archive enabled by default (DDR-047); disable with -c enableMetricArchive=false
const enableMetricArchive = app.node.tryGetContext('enableMetricArchive') !== 'false';

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
// 2. Registry (DDR-046: all ECR repos in one stack, no Lambdas)
// =========================================================================
// Deploys before any application stack. Contains only ECR repositories,
// breaking the chicken-and-egg dependency where DockerImageFunction requires
// an image that the pipeline (which depends on the app stack) hasn't pushed yet.
const registry = new RegistryStack(app, 'AiSocialMediaRegistry', { env });

// =========================================================================
// 3. Backend (STATELESS): 5 Lambdas + API Gateway + Cognito + 2 Step Functions (DDR-035)
// =========================================================================
// ECR repos come from RegistryStack (DDR-046)
const backend = new BackendStack(app, 'AiSocialMediaBackend', {
  env,
  mediaBucket: storage.mediaBucket,
  sessionsTable: storage.sessionsTable,
  lightEcrRepo: registry.lightEcrRepo,
  heavyEcrRepo: registry.heavyEcrRepo,
  publicLightEcrRepo: registry.publicLightEcrRepo,
  publicHeavyEcrRepo: registry.publicHeavyEcrRepo,
});
backend.addDependency(storage);
backend.addDependency(registry);

// =========================================================================
// 4. Frontend (STATELESS): CloudFront with OAC, security headers, origin-verify, /api/* proxy
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
// 5. Frontend Pipeline (STATELESS): Preact SPA build -> S3 + CloudFront invalidation (DDR-035)
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
// 6. Webhook (STATELESS): Dedicated CloudFront + API Gateway + Lambda for Meta webhooks (DDR-044)
// =========================================================================
// ECR repo comes from RegistryStack (DDR-046)
const webhook = new WebhookStack(app, 'AiSocialMediaWebhook', {
  env,
  webhookEcrRepo: registry.webhookEcrRepo,
});
webhook.addDependency(registry);

// =========================================================================
// 7. Backend Pipeline (STATELESS): 6 Docker builds -> 6 Lambda updates (DDR-035, DDR-041, DDR-044)
// =========================================================================
// ECR repos come from RegistryStack (DDR-046), artifact bucket from StorageStack (DDR-045)
const backendPipeline = new BackendPipelineStack(app, 'AiSocialMediaBackendPipeline', {
  env,
  lightEcrRepo: registry.lightEcrRepo,
  heavyEcrRepo: registry.heavyEcrRepo,
  publicLightRepoName: registry.publicLightEcrRepo.repositoryName!,
  publicHeavyRepoName: registry.publicHeavyEcrRepo.repositoryName!,
  apiHandler: backend.apiHandler,
  thumbnailProcessor: backend.thumbnailProcessor,
  selectionProcessor: backend.selectionProcessor,
  enhancementProcessor: backend.enhancementProcessor,
  videoProcessor: backend.videoProcessor,
  webhookEcrRepo: registry.webhookEcrRepo,
  webhookHandler: webhook.webhookHandler,
  codeStarConnectionArn,
  artifactBucket: storage.beArtifactBucket,
});
backendPipeline.addDependency(backend);
backendPipeline.addDependency(webhook);

// =========================================================================
// 8. Operations — Alerts (STATELESS): Alarms, SNS, X-Ray (DDR-047: split for fast deploys)
// =========================================================================
const lambdaEntries = [
  { id: 'ApiHandler', fn: backend.apiHandler },
  { id: 'ThumbnailProcessor', fn: backend.thumbnailProcessor },
  { id: 'SelectionProcessor', fn: backend.selectionProcessor },
  { id: 'EnhancementProcessor', fn: backend.enhancementProcessor },
  { id: 'VideoProcessor', fn: backend.videoProcessor },
];

const opsAlert = new OperationsAlertStack(app, 'AiSocialMediaOperationsAlert', {
  env,
  lambdas: lambdaEntries,
  httpApi: backend.httpApi,
  selectionPipeline: backend.selectionPipeline,
  enhancementPipeline: backend.enhancementPipeline,
  alertEmail: app.node.tryGetContext('alertEmail'),
});
opsAlert.addDependency(backend);

// =========================================================================
// 9. Operations — Monitoring (STATELESS): Dashboard, metric filters, Firehose, Glue (DDR-047)
// =========================================================================
// Log/metrics archive buckets come from StorageStack (DDR-045)
const opsMonitoring = new OperationsMonitoringStack(app, 'AiSocialMediaOperationsMonitoring', {
  env,
  lambdas: lambdaEntries,
  httpApi: backend.httpApi,
  selectionPipeline: backend.selectionPipeline,
  enhancementPipeline: backend.enhancementPipeline,
  sessionsTable: storage.sessionsTable,
  mediaBucket: storage.mediaBucket,
  logArchiveBucket: storage.logArchiveBucket,
  metricsArchiveBucket: storage.metricsArchiveBucket,
  alarms: opsAlert.alarms,
});
opsMonitoring.addDependency(backend);
opsMonitoring.addDependency(storage);
opsMonitoring.addDependency(opsAlert);

app.synth();
