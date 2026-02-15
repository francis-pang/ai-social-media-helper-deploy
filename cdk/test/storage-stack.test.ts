import { Template } from 'aws-cdk-lib/assertions';
import { storage, registry } from './test-helpers';

describe('StorageStack (DDR-045: stateful stack — all S3 buckets + DynamoDB)', () => {
  test('creates media uploads bucket with lifecycle', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-uploads-123456789012',
      LifecycleConfiguration: {
        Rules: [{ ExpirationInDays: 1, Id: 'expire-uploads-24h', Status: 'Enabled' }],
      },
    });
  });

  test('creates MediaProcess Lambda and S3 event notification (DDR-061)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 1024,
      Timeout: 300,
    });
    template.resourceCountIs('AWS::Lambda::Permission', 1); // S3 can invoke MediaProcess
  });

  test('creates DynamoDB file processing table (DDR-061)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'media-file-processing',
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

  test('creates DynamoDB sessions table with TTL', () => {
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

  test('creates frontend assets bucket (DDR-045)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-frontend-123456789012',
    });
  });

  test('creates log archive bucket with lifecycle (DDR-045)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-logs-archive-123456789012',
    });
  });

  test('creates pipeline artifact buckets (DDR-045)', () => {
    const template = Template.fromStack(storage);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-be-artifacts-123456789012',
    });
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'ai-social-media-fe-artifacts-123456789012',
    });
  });

  test('has termination protection enabled (DDR-045)', () => {
    expect(storage.terminationProtection).toBe(true);
  });
});

describe('RegistryStack (DDR-046: all ECR repos in one stack, no Lambdas)', () => {
  test('creates 4 ECR Private repositories (DDR-046, DDR-048)', () => {
    const template = Template.fromStack(registry);

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-lambda-light',
    });

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-lambda-heavy',
    });

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-webhook',
    });

    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'ai-social-media-oauth',
    });

    template.resourceCountIs('AWS::ECR::Repository', 4);
  });

  test('creates 2 ECR Public repositories (DDR-046)', () => {
    const template = Template.fromStack(registry);

    template.hasResourceProperties('AWS::ECR::PublicRepository', {
      RepositoryName: 'ai-social-media-lambda-light',
    });

    template.hasResourceProperties('AWS::ECR::PublicRepository', {
      RepositoryName: 'ai-social-media-lambda-heavy',
    });

    template.resourceCountIs('AWS::ECR::PublicRepository', 2);
  });

  test('creates no Lambda functions (DDR-046)', () => {
    const template = Template.fromStack(registry);
    template.resourceCountIs('AWS::Lambda::Function', 0);
  });
});
