import * as cdk from 'aws-cdk-lib/core';
import { StorageStack } from '../lib/storage-stack';
import { RegistryStack } from '../lib/registry-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendPipelineStack } from '../lib/frontend-pipeline-stack';
import { BackendPipelineStack } from '../lib/backend-pipeline-stack';
import { WebhookStack } from '../lib/webhook-stack';

const app = new cdk.App();
const env = { account: '123456789012', region: 'us-east-1' };

// DDR-046: RegistryStack owns all ECR repos — no Lambdas, deploys first
export const registry = new RegistryStack(app, 'TestRegistry', { env });
// DDR-045: StorageStack is the stateful stack — all S3 buckets + DynamoDB here
// DDR-061: StorageStack also creates MediaProcess Lambda (for S3 event notification)
export const storage = new StorageStack(app, 'TestStorage', {
  env,
  heavyEcrRepo: registry.heavyEcrRepo,
});
export const backend = new BackendStack(app, 'TestBackend', {
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
export const frontend = new FrontendStack(app, 'TestFrontend', {
  env,
  frontendBucketName: storage.frontendBucket.bucketName,
});
export const frontendPipeline = new FrontendPipelineStack(app, 'TestFrontendPipeline', {
  env,
  frontendBucket: storage.frontendBucket,
  distribution: frontend.distribution,
  codeStarConnectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id',
  cognitoUserPoolId: backend.userPool.userPoolId,
  cognitoClientId: backend.userPoolClient.userPoolClientId,
  artifactBucket: storage.feArtifactBucket,
});
export const webhook = new WebhookStack(app, 'TestWebhook', {
  env,
  webhookEcrRepo: registry.webhookEcrRepo,
  oauthEcrRepo: registry.oauthEcrRepo,
});
export const backendPipeline = new BackendPipelineStack(app, 'TestBackendPipeline', {
  env,
  lightEcrRepo: registry.lightEcrRepo,
  heavyEcrRepo: registry.heavyEcrRepo,
  publicLightRepoName: 'ai-social-media-lambda-light',
  publicHeavyRepoName: 'ai-social-media-lambda-heavy',
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
  codeStarConnectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id',
  artifactBucket: storage.beArtifactBucket,
});
