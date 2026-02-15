import { Template } from 'aws-cdk-lib/assertions';
import { frontendPipeline, backendPipeline } from './test-helpers';

describe('FrontendPipelineStack (DDR-045: stateless — no S3 bucket creation)', () => {
  test('creates CodePipeline with 3 stages', () => {
    const template = Template.fromStack(frontendPipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'AiSocialMediaFrontendPipeline',
    });
    // 2 CodeBuild projects: frontend build + CloudFront invalidation
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  test('does not create S3 buckets (DDR-045)', () => {
    const template = Template.fromStack(frontendPipeline);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });
});

describe('BackendPipelineStack (DDR-045: stateless — no S3 bucket creation)', () => {
  test('creates CodePipeline with 3 stages', () => {
    const template = Template.fromStack(backendPipeline);
    template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
      Name: 'AiSocialMediaBackendPipeline',
    });
    // 2 CodeBuild projects: Docker builds + Lambda deploy
    template.resourceCountIs('AWS::CodeBuild::Project', 2);
  });

  test('does not create S3 buckets (DDR-045)', () => {
    const template = Template.fromStack(backendPipeline);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });
});
