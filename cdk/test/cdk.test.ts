import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { PipelineStack } from '../lib/pipeline-stack';

describe('AiSocialMedia Infrastructure', () => {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  const storage = new StorageStack(app, 'TestStorage', { env });
  const backend = new BackendStack(app, 'TestBackend', {
    env,
    mediaBucket: storage.mediaBucket,
  });
  const frontend = new FrontendStack(app, 'TestFrontend', {
    env,
    apiEndpoint: backend.httpApi.apiEndpoint,
    originVerifySecret: 'test-origin-verify-secret',
  });
  const pipeline = new PipelineStack(app, 'TestPipeline', {
    env,
    frontendBucket: frontend.frontendBucket,
    distribution: frontend.distribution,
    lambdaFunction: backend.handler,
    ecrRepository: backend.ecrRepository,
    codeStarConnectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id',
    cognitoUserPoolId: backend.userPool.userPoolId,
    cognitoClientId: backend.userPoolClient.userPoolClientId,
  });

  test('StorageStack creates media uploads bucket with lifecycle', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-uploads-123456789012',
      LifecycleConfiguration: {
        Rules: [{ ExpirationInDays: 1, Id: 'expire-uploads-24h', Status: 'Enabled' }],
      },
    });
  });

  test('FrontendStack creates CloudFront distribution', () => {
    const template = Template.fromStack(frontend);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  test('BackendStack creates Lambda function and API Gateway', () => {
    const template = Template.fromStack(backend);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AiSocialMediaApiHandler',
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  test('PipelineStack creates CodePipeline with 3 stages', () => {
    const template = Template.fromStack(pipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'AiSocialMediaPipeline',
    });
    // Artifacts bucket with 7-day lifecycle
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-artifacts-123456789012',
      LifecycleConfiguration: {
        Rules: [{ ExpirationInDays: 7, Id: 'expire-artifacts-7d', Status: 'Enabled' }],
      },
    });
    // 3 CodeBuild projects: backend build, frontend build, deploy
    template.resourceCountIs('AWS::CodeBuild::Project', 3);
  });
});
