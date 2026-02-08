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
}

/**
 * FrontendStack creates S3 + CloudFront for hosting the Preact SPA.
 *
 * - S3 bucket is fully private (CloudFront OAC only)
 * - CloudFront serves with HTTPS redirect, security headers, and SPA routing
 * - /api/* requests are proxied to API Gateway (same-origin, no CORS needed)
 * - Hashed assets (/assets/*) cached for 1 year; index.html cached for 5 minutes
 */
export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly frontendBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // --- S3 Bucket (private, OAC-only access) ---
    this.frontendBucket = new s3.Bucket(this, 'FrontendAssets', {
      bucketName: `ai-social-media-frontend-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

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
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.frontendBucket);

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
      value: this.frontendBucket.bucketName,
      description: 'Frontend S3 bucket name',
    });
  }
}
