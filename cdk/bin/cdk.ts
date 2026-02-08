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

// CodeStar connection ARN — read from environment or use default (DDR-028 Problem 15)
const codeStarConnectionArn = process.env.CODESTAR_CONNECTION_ARN
  || 'arn:aws:codeconnections:us-east-1:123456789012:connection/YOUR_CONNECTION_ID';

// 1. Storage: Media uploads S3 bucket with 24h lifecycle
const storage = new StorageStack(app, 'AiSocialMediaStorage', { env });

// 2. Backend: Lambda (Go) + API Gateway HTTP API + Cognito auth (DDR-028)
const backend = new BackendStack(app, 'AiSocialMediaBackend', {
  env,
  mediaBucket: storage.mediaBucket,
});
backend.addDependency(storage);

// 3. Frontend: S3 + CloudFront with OAC, security headers, origin-verify, and /api/* proxy
const frontend = new FrontendStack(app, 'AiSocialMediaFrontend', {
  env,
  apiEndpoint: backend.httpApi.apiEndpoint,
  originVerifySecret: cdk.Fn.select(2, cdk.Fn.split('/', backend.stackId)),
});
frontend.addDependency(backend);

// 4. Pipeline: CodePipeline with GitHub source, parallel builds, and deploy stages
const pipeline = new PipelineStack(app, 'AiSocialMediaPipeline', {
  env,
  frontendBucket: frontend.frontendBucket,
  distribution: frontend.distribution,
  lambdaFunction: backend.handler,
  ecrRepository: backend.ecrRepository,
  codeStarConnectionArn,
  cognitoUserPoolId: backend.userPool.userPoolId,
  cognitoClientId: backend.userPoolClient.userPoolClientId,
});
pipeline.addDependency(frontend);

app.synth();
