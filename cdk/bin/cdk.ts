#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { StorageStack } from '../lib/storage-stack';
import { RegistryStack } from '../lib/registry-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendPipelineStack } from '../lib/frontend-pipeline-stack';
import { BackendPipelineStack } from '../lib/backend-pipeline-stack';
import { OperationsAlertStack } from '../lib/operations-alert-stack';
import { OperationsDashboardStack } from '../lib/operations-dashboard-stack';
import { OperationsMonitoringStack } from '../lib/operations-monitoring-stack';
import { WebhookStack } from '../lib/webhook-stack';

const app = new cdk.App();

// Tag every resource for cost tracking in AWS Cost Explorer (DDR-049).
cdk.Tags.of(app).add('Project', 'ai-social-media-helper');

// All resources use 'AiSocialMedia' prefix to match scoped IAM policies (DDR-023).
// S3 buckets use 'ai-social-media-' prefix (lowercase with hyphens per S3 naming rules).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// Metric archive enabled by default (DDR-047); disable with -c enableMetricArchive=false
const enableMetricArchive = app.node.tryGetContext('enableMetricArchive') !== 'false';

// =========================================================================
// 1. Registry (DDR-046: all ECR repos in one stack, no Lambdas)
// =========================================================================
// Deploys before any application stack. Contains only ECR repositories,
// breaking the chicken-and-egg dependency where DockerImageFunction requires
// an image that the pipeline (which depends on the app stack) hasn't pushed yet.
const registry = new RegistryStack(app, 'AiSocialMediaRegistry', { env });

// =========================================================================
// 2. Storage (STATEFUL — DDR-045: all S3 buckets + DynamoDB in one stack)
// =========================================================================
// This stack is termination-protected and rarely changes. All stateful
// resources live here so stateless stacks can be freely destroyed/redeployed
// without orphaning S3 buckets.
// MediaProcess Lambda lives here to avoid cyclic dependency with S3 event notification (DDR-061).
const storage = new StorageStack(app, 'AiSocialMediaStorage', {
  env,
  enableMetricArchive,
  heavyEcrRepo: registry.heavyEcrRepo,
});
storage.addDependency(registry);

// CodeStar connection ARN — env, then SSM lookup (DDR-028). Never use placeholder.
const codeStarConnectionArn = process.env.CODESTAR_CONNECTION_ARN
  || ssm.StringParameter.valueFromLookup(storage, '/ai-social-media/codestar-connection-arn');
const PLACEHOLDER_ARN = 'arn:aws:codeconnections:us-east-1:123456789012:connection/YOUR_CONNECTION_ID';
if (codeStarConnectionArn === PLACEHOLDER_ARN || codeStarConnectionArn.includes('YOUR_CONNECTION_ID')) {
  throw new Error('CodeStar connection ARN must be set via CODESTAR_CONNECTION_ARN env or SSM /ai-social-media/codestar-connection-arn. Do not deploy pipeline stacks with placeholder.');
}

// =========================================================================
// 3. Backend (STATELESS): 11 Lambdas + API Gateway + Cognito + 4 Step Functions (DDR-035, DDR-053)
// =========================================================================
// ECR repos come from RegistryStack (DDR-046)
const backend = new BackendStack(app, 'AiSocialMediaBackend', {
  env,
  mediaBucket: storage.mediaBucket,
  sessionsTable: storage.sessionsTable,
  fileProcessingTable: storage.fileProcessingTable,
  mediaProcessProcessor: storage.mediaProcessProcessor,
  lightEcrRepo: registry.lightEcrRepo,
  heavyEcrRepo: registry.heavyEcrRepo,
  publicLightEcrRepo: registry.publicLightEcrRepo,
  publicHeavyEcrRepo: registry.publicHeavyEcrRepo,
});
backend.addDependency(storage);
backend.addDependency(registry);

// =========================================================================
// 4. Frontend (STATELESS): CloudFront with OAC, security headers, origin-verify via SSM, /api/* proxy (DDR-054)
// =========================================================================
// S3 bucket name passed as string to avoid cross-stack OAC cycle (DDR-045).
// FrontendStack imports the bucket by name and manages the OAC bucket policy locally.
const frontend = new FrontendStack(app, 'AiSocialMediaFrontend', {
  env,
  frontendBucketName: storage.frontendBucket.bucketName,
});
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
// 6. Webhook (STATELESS): CloudFront + API Gateway + Lambdas for Meta callbacks (DDR-044, DDR-048)
// =========================================================================
// ECR repos come from RegistryStack (DDR-046)
const webhook = new WebhookStack(app, 'AiSocialMediaWebhook', {
  env,
  webhookEcrRepo: registry.webhookEcrRepo,
  oauthEcrRepo: registry.oauthEcrRepo,
});
webhook.addDependency(registry);

// =========================================================================
// 7. Backend Pipeline (STATELESS): 11 Docker builds -> 11 Lambda updates (DDR-035, DDR-041, DDR-044, DDR-048, DDR-053)
// =========================================================================
// ECR repos come from RegistryStack (DDR-046), artifact bucket from StorageStack (DDR-045)
const backendPipeline = new BackendPipelineStack(app, 'AiSocialMediaBackendPipeline', {
  env,
  lightEcrRepo: registry.lightEcrRepo,
  heavyEcrRepo: registry.heavyEcrRepo,
  publicLightRepoName: registry.publicLightEcrRepo.repositoryName!,
  publicHeavyRepoName: registry.publicHeavyEcrRepo.repositoryName!,
  apiHandler: backend.apiHandler,
  triageProcessor: backend.triageProcessor,
  descriptionProcessor: backend.descriptionProcessor,
  downloadProcessor: backend.downloadProcessor,
  publishProcessor: backend.publishProcessor,
  thumbnailProcessor: backend.thumbnailProcessor,
  selectionProcessor: backend.selectionProcessor,
  enhancementProcessor: backend.enhancementProcessor,
  videoProcessor: backend.videoProcessor,
  mediaProcessProcessor: backend.mediaProcessProcessor,
  webhookEcrRepo: registry.webhookEcrRepo,
  webhookHandler: webhook.webhookHandler,
  oauthEcrRepo: registry.oauthEcrRepo,
  oauthHandler: webhook.oauthHandler,
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
  { id: 'TriageProcessor', fn: backend.triageProcessor },
  { id: 'DescriptionProcessor', fn: backend.descriptionProcessor },
  { id: 'DownloadProcessor', fn: backend.downloadProcessor },
  { id: 'PublishProcessor', fn: backend.publishProcessor },
  { id: 'ThumbnailProcessor', fn: backend.thumbnailProcessor },
  { id: 'SelectionProcessor', fn: backend.selectionProcessor },
  { id: 'EnhancementProcessor', fn: backend.enhancementProcessor },
  { id: 'VideoProcessor', fn: backend.videoProcessor },
  { id: 'MediaProcessProcessor', fn: backend.mediaProcessProcessor },
];

const opsAlert = new OperationsAlertStack(app, 'AiSocialMediaOperationsAlert', {
  env,
  lambdas: lambdaEntries,
  httpApi: backend.httpApi,
  selectionPipeline: backend.selectionPipeline,
  enhancementPipeline: backend.enhancementPipeline,
  triagePipeline: backend.triagePipeline,
  publishPipeline: backend.publishPipeline,
  alertEmail: app.node.tryGetContext('alertEmail'),
});
opsAlert.addDependency(backend);

// =========================================================================
// 9. Operations — Log Ingestion (STATELESS): Metric filters, Firehose, Glue (DDR-047, DDR-054)
// =========================================================================
// Log/metrics archive buckets come from StorageStack (DDR-045)
const opsMonitoring = new OperationsMonitoringStack(app, 'AiSocialMediaOperationsMonitoring', {
  env,
  lambdas: lambdaEntries,
  logArchiveBucket: storage.logArchiveBucket,
  metricsArchiveBucket: storage.metricsArchiveBucket,
});
opsMonitoring.addDependency(storage);

// =========================================================================
// 10. Operations — Dashboard (STATELESS): ~45-widget CloudWatch dashboard (DDR-054: split for fast deploys)
// =========================================================================
const opsDashboard = new OperationsDashboardStack(app, 'AiSocialMediaOperationsDashboard', {
  env,
  lambdas: lambdaEntries,
  httpApi: backend.httpApi,
  selectionPipeline: backend.selectionPipeline,
  enhancementPipeline: backend.enhancementPipeline,
  triagePipeline: backend.triagePipeline,
  publishPipeline: backend.publishPipeline,
  sessionsTable: storage.sessionsTable,
  fileProcessingTable: storage.fileProcessingTable,
  mediaBucket: storage.mediaBucket,
  alarms: opsAlert.alarms,
});
opsDashboard.addDependency(backend);
opsDashboard.addDependency(storage);
opsDashboard.addDependency(opsAlert);

app.synth();
