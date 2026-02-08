import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  /** CloudFront distribution domain for S3 CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
}

/**
 * StorageStack creates the S3 bucket for ephemeral media uploads.
 *
 * - Block all public access; files are accessed only via presigned URLs
 * - 24-hour lifecycle rule (triage media is ephemeral)
 * - CORS restricted to CloudFront domain (DDR-028 Problem 9)
 */
export class StorageStack extends cdk.Stack {
  public readonly mediaBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: StorageStackProps) {
    super(scope, id, props);

    // Restrict S3 CORS to CloudFront domain if known (DDR-028 Problem 9)
    const allowedOrigins = props?.cloudFrontDomain
      ? [`https://${props.cloudFrontDomain}`]
      : ['https://*.cloudfront.net']; // Fallback: allow any CloudFront distribution

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
          allowedOrigins,
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
