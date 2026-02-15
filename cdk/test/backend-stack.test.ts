import { Template } from 'aws-cdk-lib/assertions';
import { backend } from './test-helpers';

describe('BackendStack', () => {
  test('creates 9 Lambda functions (DDR-053)', () => {
    const template = Template.fromStack(backend);

    // API Lambda (256 MB, 30s)
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 256,
      Timeout: 30,
    });

    // Thumbnail Lambda (512 MB, 2 min)
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 512,
      Timeout: 120,
    });

    // Selection + Video Lambdas (4 GB, 15 min)
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 4096,
      Timeout: 900,
    });

    // Enhancement + Description Lambdas (2 GB, 5 min)
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 2048,
      Timeout: 300,
    });

    // Triage + Download Lambdas (2 GB, 10 min)
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 2048,
      Timeout: 600,
    });

    // Publish Lambda (256 MB, 5 min)
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 256,
      Timeout: 300,
    });

    // Total: 9 Lambda functions (api, triage, description, download, publish, thumbnail, selection, enhancement, video)
    // MediaProcess Lambda lives in StorageStack (DDR-061)
    template.resourceCountIs('AWS::Lambda::Function', 9);
  });

  test('creates 4 Step Functions state machines (DDR-052, DDR-053)', () => {
    const template = Template.fromStack(backend);

    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'AiSocialMediaSelectionPipeline',
    });

    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'AiSocialMediaEnhancementPipeline',
    });

    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'AiSocialMediaTriagePipeline',
    });

    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'AiSocialMediaPublishPipeline',
    });

    template.resourceCountIs('AWS::StepFunctions::StateMachine', 4);
  });

  test('creates API Gateway', () => {
    const template = Template.fromStack(backend);
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  test('creates Cognito User Pool', () => {
    const template = Template.fromStack(backend);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'AiSocialMediaUsers',
    });
  });
});
