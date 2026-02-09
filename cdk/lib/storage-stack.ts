import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  /** CloudFront distribution domain for S3 CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
}

/**
 * StorageStack creates persistent data stores:
 *
 * 1. S3 bucket for ephemeral media uploads (24h auto-expiration)
 * 2. DynamoDB table for multi-step session state (DDR-035)
 *
 * S3:
 * - Block all public access; files are accessed only via presigned URLs
 * - 24-hour lifecycle rule (triage media is ephemeral)
 * - CORS restricted to CloudFront domain (DDR-028 Problem 9)
 *
 * DynamoDB:
 * - Single-table design with PK (partition key) and SK (sort key)
 * - TTL auto-cleanup via expiresAt attribute (24 hours)
 * - PAY_PER_REQUEST billing (serverless, no capacity planning)
 * - Record types: SESSION#, SELECTION#, ENHANCE#, GROUP#, DESC#
 */
export class StorageStack extends cdk.Stack {
  public readonly mediaBucket: s3.Bucket;
  public readonly sessionsTable: dynamodb.Table;

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

    // --- DynamoDB Session State Table (DDR-035) ---
    // Single-table design: all session data co-located under SESSION#{sessionId}.
    // Query(PK = SESSION#abc) retrieves the entire session state in one call.
    // TTL auto-deletes records after 24 hours (matches S3 media expiration).
    this.sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
      tableName: 'media-selection-sessions',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      description: 'Media uploads S3 bucket name',
    });

    new cdk.CfnOutput(this, 'MediaBucketArn', {
      value: this.mediaBucket.bucketArn,
      description: 'Media uploads S3 bucket ARN',
    });

    new cdk.CfnOutput(this, 'SessionsTableName', {
      value: this.sessionsTable.tableName,
      description: 'DynamoDB sessions table name',
    });

    new cdk.CfnOutput(this, 'SessionsTableArn', {
      value: this.sessionsTable.tableArn,
      description: 'DynamoDB sessions table ARN',
    });
  }
}
