#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { StorageStack } from '../lib/storage-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

// All resources use 'AiSocialMedia' prefix to match scoped IAM policies (DDR-023).
// S3 buckets use 'ai-social-media-' prefix (lowercase with hyphens per S3 naming rules).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

// 1. Storage: Media uploads S3 bucket with 24h lifecycle
const storage = new StorageStack(app, 'AiSocialMediaStorage', { env });

// 2. Backend: Lambda (Go) + API Gateway HTTP API
const backend = new BackendStack(app, 'AiSocialMediaBackend', {
  env,
  mediaBucket: storage.mediaBucket,
});
backend.addDependency(storage);

// 3. Frontend: S3 + CloudFront with OAC, security headers, and /api/* proxy to API Gateway
const frontend = new FrontendStack(app, 'AiSocialMediaFrontend', {
  env,
  apiEndpoint: backend.httpApi.apiEndpoint,
});
frontend.addDependency(backend);

// 4. Pipeline: CodePipeline with GitHub source, parallel builds, and deploy stages
const pipeline = new PipelineStack(app, 'AiSocialMediaPipeline', {
  env,
  frontendBucket: frontend.frontendBucket,
  distribution: frontend.distribution,
  lambdaFunction: backend.handler,
});
pipeline.addDependency(frontend);

app.synth();
