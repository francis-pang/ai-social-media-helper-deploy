import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * StorageStack creates the S3 bucket for ephemeral media uploads.
 *
 * - Block all public access; files are accessed only via presigned URLs
 * - 24-hour lifecycle rule (triage media is ephemeral)
 * - CORS allows PUT from any HTTPS origin (secured by presigned URLs)
 */
export class StorageStack extends cdk.Stack {
  public readonly mediaBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.mediaBucket = new s3.Bucket(this, 'MediaUploads', {
      bucketName: `ai-social-media-uploads-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(1),
          id: 'expire-uploads-24h',
        },
      ],
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ['*'], // Secured by presigned URLs; tightened when custom domain is set
          maxAge: 3600,
        },
      ],
    });

    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      description: 'Media uploads S3 bucket name',
    });

    new cdk.CfnOutput(this, 'MediaBucketArn', {
      value: this.mediaBucket.bucketArn,
      description: 'Media uploads S3 bucket ARN',
    });
  }
}
