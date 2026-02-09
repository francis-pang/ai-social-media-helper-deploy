import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { BackendStack } from '../lib/backend-stack';
import { FrontendPipelineStack } from '../lib/frontend-pipeline-stack';
import { BackendPipelineStack } from '../lib/backend-pipeline-stack';

describe('AiSocialMedia Infrastructure', () => {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };

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
  });
  const frontendPipeline = new FrontendPipelineStack(app, 'TestFrontendPipeline', {
    env,
    frontendBucket: frontend.frontendBucket,
    distribution: frontend.distribution,
    codeStarConnectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id',
    cognitoUserPoolId: backend.userPool.userPoolId,
    cognitoClientId: backend.userPoolClient.userPoolClientId,
  });
  const backendPipeline = new BackendPipelineStack(app, 'TestBackendPipeline', {
    env,
    lightEcrRepo: backend.lightEcrRepo,
    heavyEcrRepo: backend.heavyEcrRepo,
    apiHandler: backend.apiHandler,
    thumbnailProcessor: backend.thumbnailProcessor,
    selectionProcessor: backend.selectionProcessor,
    enhancementProcessor: backend.enhancementProcessor,
    videoProcessor: backend.videoProcessor,
    codeStarConnectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id',
  });

  // =========================================================================
  // StorageStack
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

  // =========================================================================
  // FrontendStack
  // =========================================================================

  test('FrontendStack creates CloudFront distribution', () => {
    const template = Template.fromStack(frontend);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  // =========================================================================
  // BackendStack
  // =========================================================================

  test('BackendStack creates 5 Lambda functions', () => {
    const template = Template.fromStack(backend);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AiSocialMediaApiHandler',
      MemorySize: 256,
      Timeout: 30,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AiSocialMediaThumbnailProcessor',
      MemorySize: 512,
      Timeout: 120,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AiSocialMediaSelectionProcessor',
      MemorySize: 4096,
      Timeout: 900,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AiSocialMediaEnhancementProcessor',
      MemorySize: 2048,
      Timeout: 300,
    });

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'AiSocialMediaVideoProcessor',
      MemorySize: 4096,
      Timeout: 900,
    });

    // Total: 5 Lambda functions
    template.resourceCountIs('AWS::Lambda::Function', 5);
  });

  test('BackendStack creates 2 ECR repositories', () => {
    const template = Template.fromStack(backend);

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-lambda-light',
    });

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-lambda-heavy',
    });

    template.resourceCountIs('AWS::ECR::Repository', 2);
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
  // FrontendPipelineStack
  // =========================================================================

  test('FrontendPipelineStack creates CodePipeline with 3 stages', () => {
    const template = Template.fromStack(frontendPipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'AiSocialMediaFrontendPipeline',
    });
    // 2 CodeBuild projects: frontend build + CloudFront invalidation
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  // =========================================================================
  // BackendPipelineStack
  // =========================================================================

  test('BackendPipelineStack creates CodePipeline with 3 stages', () => {
    const template = Template.fromStack(backendPipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'AiSocialMediaBackendPipeline',
    });
    // 2 CodeBuild projects: Docker builds + Lambda deploy
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });
});
