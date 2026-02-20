import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
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

    // Read stable values — decoupled from BackendStack (DDR-054: deploy speed).
    // API endpoint from SSM (not a secret — written by BackendStack).
    const apiEndpoint = ssm.StringParameter.valueForStringParameter(
      this, '/ai-social-media/api-endpoint');
    // Origin-verify secret from Secrets Manager (Risk 5: crypto random, encrypted at rest).
    // Use SecretValue.secretsManager() to resolve by name — fromSecretNameV2 generates a
    // partial ARN that CloudFormation's dynamic reference resolver can't find.
    const originVerifySecret = cdk.SecretValue.secretsManager(
      'ai-social-media/origin-verify-secret').unsafeUnwrap();

    // Import bucket by name — avoids cross-stack OAC cycle (DDR-045)
    // The bucket is created in StorageStack with autoDeleteObjects: true.
    // Importing it here means addToResourcePolicy() is a no-op, so we
    // create the OAC bucket policy manually below.
    this.frontendBucket = s3.Bucket.fromBucketName(
      this, 'FrontendBucket', props.frontendBucketName,
    );

    // --- CSP Header Function (viewer-response) ---
    // Managed SecurityHeadersPolicy covers HSTS, X-Content-Type-Options, X-Frame-Options,
    // Referrer-Policy, and X-XSS-Protection. It does not support custom CSP values, so
    // this CloudFront Function injects the CSP header on every viewer response.
    const cspValue = [
      "default-src 'self'",
      "img-src 'self' blob: data: https://*.s3.us-east-1.amazonaws.com https://*.s3.amazonaws.com",
      "media-src 'self' https://*.s3.us-east-1.amazonaws.com https://*.s3.amazonaws.com",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://*.s3.us-east-1.amazonaws.com https://*.s3.amazonaws.com https://cognito-idp.us-east-1.amazonaws.com",
    ].join('; ');

    const cspHeaderFunction = new cloudfront.Function(this, 'CspHeaderFunction', {
      functionName: 'AiSocialMediaCspHeaders',
      code: cloudfront.FunctionCode.fromInline([
        'function handler(event) {',
        '  var response = event.response;',
        `  response.headers['content-security-policy'] = { value: "${cspValue}" };`,
        '  return response;',
        '}',
      ].join('\n')),
      comment: 'Inject CSP header — complements managed SecurityHeadersPolicy which lacks custom CSP support',
    });

    // --- CloudFront Function for SPA routing (DDR-062) ---
    // Replaces distribution-level errorResponses which masked API 403/404 errors.
    // Attached to the default behavior (S3 origin) only — /api/* is unaffected.
    // Rewrites non-file paths (SPA routes like /triage/abc) to /index.html.
    const spaRoutingFunction = new cloudfront.Function(this, 'SpaRoutingFunction', {
      functionName: 'AiSocialMediaSpaRouting',
      code: cloudfront.FunctionCode.fromInline([
        'function handler(event) {',
        '  var request = event.request;',
        '  var uri = request.uri;',
        '  // Pass through requests for static files (have a file extension)',
        '  if (uri.includes(\'.\')) {',
        '    return request;',
        '  }',
        '  // SPA route: rewrite to /index.html for client-side routing',
        '  request.uri = \'/index.html\';',
        '  return request;',
        '}',
      ].join('\n')),
      comment: 'Rewrite non-file SPA routes to /index.html — replaces distribution-level errorResponses (DDR-062)',
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
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      customHeaders: {
        'x-origin-verify': originVerifySecret,
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'AI Social Media Helper — Preact SPA frontend + /api/* proxy to API Gateway',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      publishAdditionalMetrics: true,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: spaRoutingFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
          {
            function: cspHeaderFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
          },
        ],
      },
      additionalBehaviors: {
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          functionAssociations: [{
            function: cspHeaderFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
          }],
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

    // Risk 7+14: Write CloudFront domain to SSM for cross-stack CORS lockdown.
    // BackendStack and StorageStack read this via valueFromLookup at synth time.
    new ssm.StringParameter(this, 'CloudFrontDomainParam', {
      parameterName: '/ai-social-media/cloudfront-domain',
      stringValue: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain (consumed by Backend/Storage for CORS lockdown)',
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
