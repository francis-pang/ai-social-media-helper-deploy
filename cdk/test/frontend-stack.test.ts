import { Template } from 'aws-cdk-lib/assertions';
import { frontend } from './test-helpers';

describe('FrontendStack (DDR-045: stateless — no S3 bucket creation)', () => {
  test('creates CloudFront distribution', () => {
    const template = Template.fromStack(frontend);
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  test('does not create S3 buckets (DDR-045)', () => {
    const template = Template.fromStack(frontend);
    template.resourceCountIs('AWS::S3::Bucket', 0);
  });
});
