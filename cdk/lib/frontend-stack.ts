import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  /** API Gateway endpoint URL (e.g. https://xxx.execute-api.us-east-1.amazonaws.com) */
  apiEndpoint: string;
  /** Origin-verify shared secret — CloudFront sends this header to API Gateway (DDR-028) */
  originVerifySecret: string;
  /**
   * Frontend S3 bucket name (from StorageStack — DDR-045: stateful/stateless split).
   * Passed as a string to avoid cross-stack OAC cycle (bucket policy ↔ distribution).
   * FrontendStack imports the bucket locally and manages the OAC bucket policy.
   */
  frontendBucketName: string;
}

/**
 * FrontendStack creates CloudFront for hosting the Preact SPA.
 *
 * The S3 bucket is owned by StorageStack (DDR-045: stateful/stateless split).
 * This stack imports the bucket by name and manages the OAC bucket policy locally
 * to avoid a cross-stack cyclic dependency.
 *
 * - CloudFront serves with HTTPS redirect, security headers, and SPA routing
 * - /api/* requests are proxied to API Gateway (same-origin, no CORS needed)
 * - Hashed assets (/assets/*) cached for 1 year; index.html cached for 5 minutes
 */
export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly frontendBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // Import bucket by name — avoids cross-stack OAC cycle (DDR-045)
    // The bucket is created in StorageStack with autoDeleteObjects: true.
    // Importing it here means addToResourcePolicy() is a no-op, so we
    // create the OAC bucket policy manually below.
    this.frontendBucket = s3.Bucket.fromBucketName(
      this, 'FrontendBucket', props.frontendBucketName,
    );

    // --- Security Headers Policy ---
    // Mirrors the headers set in cmd/media-web/main.go lines 152-156,
    // adapted for remote hosting (connect-src includes API Gateway and S3).
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: 'AiSocialMediaSecurityHeaders',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: [
            "default-src 'self'",
            "img-src 'self' blob: data:",
            "style-src 'self' 'unsafe-inline'",
            "connect-src 'self' https://*.s3.us-east-1.amazonaws.com https://*.s3.amazonaws.com https://cognito-idp.us-east-1.amazonaws.com",
          ].join('; '),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(63072000), // 2 years
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    // --- Cache Policies ---
    // Short cache for index.html (frequently updated on deploy)
    const defaultCachePolicy = new cloudfront.CachePolicy(this, 'DefaultCachePolicy', {
      cachePolicyName: 'AiSocialMediaDefaultCache',
      defaultTtl: cdk.Duration.minutes(5),
      maxTtl: cdk.Duration.hours(1),
      minTtl: cdk.Duration.seconds(0),
    });

    // Long cache for hashed assets (cache-busted by Vite's content hashing)
    const assetsCachePolicy = new cloudfront.CachePolicy(this, 'AssetsCachePolicy', {
      cachePolicyName: 'AiSocialMediaAssetsCache',
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(1),
    });

    // --- CloudFront Distribution ---
    // S3 origin with OAC — bucket policy auto-add is a no-op for imported buckets,
    // so we add the policy manually below.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.frontendBucket);

    // Acknowledge CDK's imported-bucket OAC warning — we create the bucket policy
    // manually via CfnBucketPolicy below to avoid the cross-stack cycle (DDR-045).
    cdk.Annotations.of(this).acknowledgeWarning(
      '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
      'OAC bucket policy is managed manually via CfnBucketPolicy below (DDR-045)',
    );

    // API Gateway origin: extract domain from endpoint URL (https://xxx.execute-api...).
    // CloudFront proxies /api/* to API Gateway so the SPA makes same-origin requests.
    // The x-origin-verify custom header ensures only CloudFront can reach the API (DDR-028 Problem 1).
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', props.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      customHeaders: {
        'x-origin-verify': props.originVerifySecret,
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy,
        cachePolicy: defaultCachePolicy,
      },
      additionalBehaviors: {
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy,
          cachePolicy: assetsCachePolicy,
        },
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
      defaultRootObject: 'index.html',
      // SPA routing: serve index.html for any path that doesn't match a file
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // --- OAC Bucket Policy (manual, avoids cross-stack cycle — DDR-045) ---
    // Since the bucket is imported (fromBucketName), CDK's auto-policy is skipped.
    // We create the policy here so it lives in FrontendStack alongside the distribution,
    // avoiding the StorageStack ↔ FrontendStack cyclic dependency.
    new s3.CfnBucketPolicy(this, 'FrontendBucketOACPolicy', {
      bucket: props.frontendBucketName,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontOAC',
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Resource: cdk.Fn.join('', ['arn:aws:s3:::', props.frontendBucketName, '/*']),
            Condition: {
              StringEquals: {
                'AWS:SourceArn': cdk.Fn.join('', [
                  'arn:aws:cloudfront::',
                  this.account,
                  ':distribution/',
                  this.distribution.distributionId,
                ]),
              },
            },
          },
        ],
      },
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name (use as SPA URL)',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID (for cache invalidation)',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: props.frontendBucketName,
      description: 'Frontend S3 bucket name',
    });
  }
}
