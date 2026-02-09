import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendPipelineStack } from '../lib/frontend-pipeline-stack';
import { BackendPipelineStack } from '../lib/backend-pipeline-stack';
import { WebhookStack } from '../lib/webhook-stack';

describe('AiSocialMedia Infrastructure', () => {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

  // DDR-045: StorageStack is the stateful stack — all S3 buckets + DynamoDB here
  const storage = new StorageStack(app, 'TestStorage', { env });
  const backend = new BackendStack(app, 'TestBackend', {
    env,
    mediaBucket: storage.mediaBucket,
    sessionsTable: storage.sessionsTable,
  });
  const frontend = new FrontendStack(app, 'TestFrontend', {
    env,
    apiEndpoint: backend.httpApi.apiEndpoint,
    originVerifySecret: 'test-origin-verify-secret',
    frontendBucketName: storage.frontendBucket.bucketName,
  });
  const frontendPipeline = new FrontendPipelineStack(app, 'TestFrontendPipeline', {
    env,
    frontendBucket: storage.frontendBucket,
    distribution: frontend.distribution,
    codeStarConnectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id',
    cognitoUserPoolId: backend.userPool.userPoolId,
    cognitoClientId: backend.userPoolClient.userPoolClientId,
    artifactBucket: storage.feArtifactBucket,
  });
  const webhook = new WebhookStack(app, 'TestWebhook', { env });
  const backendPipeline = new BackendPipelineStack(app, 'TestBackendPipeline', {
    env,
    lightEcrRepo: backend.lightEcrRepo,
    heavyEcrRepo: backend.heavyEcrRepo,
    publicLightRepoName: 'ai-social-media-lambda-light',
    publicHeavyRepoName: 'ai-social-media-lambda-heavy',
    apiHandler: backend.apiHandler,
    thumbnailProcessor: backend.thumbnailProcessor,
    selectionProcessor: backend.selectionProcessor,
    enhancementProcessor: backend.enhancementProcessor,
    videoProcessor: backend.videoProcessor,
    webhookEcrRepo: webhook.webhookEcrRepo,
    webhookHandler: webhook.webhookHandler,
    codeStarConnectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id',
    artifactBucket: storage.beArtifactBucket,
  });

  // =========================================================================
  // StorageStack (DDR-045: stateful stack — all S3 buckets + DynamoDB)
  // =========================================================================

  test('StorageStack creates media uploads bucket with lifecycle', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-uploads-123456789012',
      LifecycleConfiguration: {
        Rules: [{ ExpirationInDays: 1, Id: 'expire-uploads-24h', Status: 'Enabled' }],
      },
    });
  });

  test('StorageStack creates DynamoDB sessions table with TTL', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'media-selection-sessions',
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
  });

  test('StorageStack creates frontend assets bucket (DDR-045)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-frontend-123456789012',
    });
  });

  test('StorageStack creates log archive bucket with lifecycle (DDR-045)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-logs-archive-123456789012',
    });
  });

  test('StorageStack creates pipeline artifact buckets (DDR-045)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-be-artifacts-123456789012',
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-fe-artifacts-123456789012',
    });
  });

  test('StorageStack has termination protection enabled (DDR-045)', () => {
    expect(storage.terminationProtection).toBe(true);
  });

  // =========================================================================
  // FrontendStack (DDR-045: stateless — no S3 bucket creation)
  // =========================================================================

  test('FrontendStack creates CloudFront distribution', () => {
    const template = Template.fromStack(frontend);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  test('FrontendStack does not create S3 buckets (DDR-045)', () => {
    const template = Template.fromStack(frontend);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  // =========================================================================
  // BackendStack
  // =========================================================================

  test('BackendStack creates 5 Lambda functions', () => {
    const template = Template.fromStack(backend);

    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 256,
      Timeout: 30,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Timeout: 120,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 4096,
      Timeout: 900,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 2048,
      Timeout: 300,
    });

    // Total: 5 Lambda functions
    template.resourceCountIs('AWS::Lambda::Function', 5);
  });

  test('BackendStack creates 2 ECR Private repositories (DDR-041)', () => {
    const template = Template.fromStack(backend);

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-lambda-light',
    });

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-lambda-heavy',
    });

    template.resourceCountIs('AWS::ECR::Repository', 2);
  });

  test('BackendStack creates 2 ECR Public repositories (DDR-041)', () => {
    const template = Template.fromStack(backend);

    template.hasResourceProperties('AWS::ECR::PublicRepository', {
      RepositoryName: 'ai-social-media-lambda-light',
    });

    template.hasResourceProperties('AWS::ECR::PublicRepository', {
      RepositoryName: 'ai-social-media-lambda-heavy',
    });

    template.resourceCountIs('AWS::ECR::PublicRepository', 2);
  });

  test('BackendStack creates 2 Step Functions state machines', () => {
    const template = Template.fromStack(backend);

    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'AiSocialMediaSelectionPipeline',
    });

    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'AiSocialMediaEnhancementPipeline',
    });

    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
  });

  test('BackendStack creates API Gateway', () => {
    const template = Template.fromStack(backend);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  test('BackendStack creates Cognito User Pool', () => {
    const template = Template.fromStack(backend);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'AiSocialMediaUsers',
    });
  });

  // =========================================================================
  // FrontendPipelineStack (DDR-045: stateless — no S3 bucket creation)
  // =========================================================================

  test('FrontendPipelineStack creates CodePipeline with 3 stages', () => {
    const template = Template.fromStack(frontendPipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'AiSocialMediaFrontendPipeline',
    });
    // 2 CodeBuild projects: frontend build + CloudFront invalidation
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  test('FrontendPipelineStack does not create S3 buckets (DDR-045)', () => {
    const template = Template.fromStack(frontendPipeline);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });

  // =========================================================================
  // BackendPipelineStack (DDR-045: stateless — no S3 bucket creation)
  // =========================================================================

  test('BackendPipelineStack creates CodePipeline with 3 stages', () => {
    const template = Template.fromStack(backendPipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'AiSocialMediaBackendPipeline',
    });
    // 2 CodeBuild projects: Docker builds + Lambda deploy
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  test('BackendPipelineStack does not create S3 buckets (DDR-045)', () => {
    const template = Template.fromStack(backendPipeline);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });
});
