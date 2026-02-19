import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface WebhookStackProps extends cdk.StackProps {
  /** ECR Private repository for webhook Lambda image (from RegistryStack, DDR-046) */
  webhookEcrRepo: ecr.IRepository;
  /** ECR Private repository for OAuth Lambda image (from RegistryStack, DDR-048) */
  oauthEcrRepo: ecr.IRepository;
}

/**
 * WebhookStack creates infrastructure for receiving Meta/Instagram
 * callbacks: webhook notifications (DDR-044) and OAuth redirects (DDR-048).
 *
 * Components:
 * - Webhook Lambda (128 MB, 10s) — Meta webhook verification + event handling
 * - OAuth Lambda (128 MB, 10s) — Instagram OAuth token exchange (DDR-048)
 * - API Gateway HTTP API (no auth, server-to-server / browser redirect)
 * - CloudFront distribution (HTTPS, DDoS protection)
 *
 * ECR repositories are owned by RegistryStack (DDR-046). This stack depends
 * on RegistryStack for ECR repos but has NO dependencies on BackendStack,
 * StorageStack, or FrontendStack.
 *
 * Security model:
 * - No JWT auth (Meta cannot authenticate with Cognito)
 * - No origin-verify (requests come from Meta, not CloudFront SPA)
 * - HMAC-SHA256 signature verification on POST /webhook payloads (in Lambda code)
 * - OAuth Lambda reads/writes SSM parameters for token management
 * - API Gateway throttling (10 burst / 5 steady)
 */
export class WebhookStack extends cdk.Stack {
  /** Webhook Lambda function (used by pipeline for deployment) */
  public readonly webhookHandler: lambda.Function;
  /** OAuth Lambda function (used by pipeline for deployment, DDR-048) */
  public readonly oauthHandler: lambda.Function;

  constructor(scope: Construct, id: string, props: WebhookStackProps) {
    super(scope, id, props);

    // =========================================================================
    // Lambda Function (DDR-044: 128 MB, 10s, ECR Private from RegistryStack DDR-046)
    // =========================================================================
    this.webhookHandler = new lambda.DockerImageFunction(this, 'WebhookHandler', {
      description: 'Meta webhook — verifies GET challenges and processes Instagram notification events via HMAC',
      code: lambda.DockerImageCode.fromEcr(props.webhookEcrRepo, { tagOrDigest: 'webhook-latest' }),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        SSM_WEBHOOK_VERIFY_TOKEN_PARAM: '/ai-social-media/prod/instagram-webhook-verify-token',
        SSM_APP_SECRET_PARAM: '/ai-social-media/prod/instagram-app-secret',
      },
    });

    // SSM read permission for webhook credentials
    this.webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-webhook-verify-token`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-app-secret`,
        ],
      }),
    );

    // =========================================================================
    // API Gateway HTTP API (DDR-044: no auth, throttled)
    // =========================================================================
    const httpApi = new apigwv2.HttpApi(this, 'WebhookApi', {
      apiName: 'AiSocialMediaWebhookApi',
      description: 'Webhook API — unauthenticated endpoints for Meta webhook events and Instagram OAuth callback',
      // No CORS — server-to-server from Meta
    });

    // Risk 21: Access logging for webhook API — captures all requests including
    // rejected/throttled ones before reaching the Lambda.
    const accessLogGroup = new logs.LogGroup(this, 'WebhookApiAccessLog', {
      logGroupName: '/aws/apigateway/AiSocialMediaWebhookApi',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Throttling: 10 burst / 5 steady (webhook traffic is low) + access logging (Risk 21)
    const cfnStage = httpApi.defaultStage?.node.defaultChild as cdk.CfnResource;
    if (cfnStage) {
      cfnStage.addPropertyOverride('DefaultRouteSettings', {
        ThrottlingBurstLimit: 10,
        ThrottlingRateLimit: 5,
      });
      cfnStage.addPropertyOverride('AccessLogSettings', {
        DestinationArn: accessLogGroup.logGroupArn,
        Format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          method: '$context.httpMethod',
          path: '$context.path',
          status: '$context.status',
          responseLength: '$context.responseLength',
          latency: '$context.responseLatency',
          integrationError: '$context.integrationErrorMessage',
        }),
      });
    }

    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'WebhookLambdaIntegration',
      this.webhookHandler,
    );

    // Webhook routes: GET (verification) + POST (events)
    httpApi.addRoutes({
      path: '/webhook',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: lambdaIntegration,
    });

    // =========================================================================
    // OAuth Lambda (DDR-048: Instagram token exchange)
    // =========================================================================
    this.oauthHandler = new lambda.DockerImageFunction(this, 'OAuthHandler', {
      description: 'Instagram OAuth — exchanges authorization code for long-lived token and stores in SSM',
      code: lambda.DockerImageCode.fromEcr(props.oauthEcrRepo, { tagOrDigest: 'oauth-latest' }),
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        SSM_APP_ID_PARAM: '/ai-social-media/prod/instagram-app-id',
        SSM_APP_SECRET_PARAM: '/ai-social-media/prod/instagram-app-secret',
        SSM_REDIRECT_URI_PARAM: '/ai-social-media/prod/instagram-oauth-redirect-uri',
        SSM_TOKEN_PARAM: '/ai-social-media/prod/instagram-access-token',
        SSM_USER_ID_PARAM: '/ai-social-media/prod/instagram-user-id',
      },
    });

    // SSM read permission for OAuth credentials + CSRF state (Risk 19D)
    this.oauthHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-app-id`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-app-secret`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-oauth-redirect-uri`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/oauth-csrf-state`,
        ],
      }),
    );

    // SSM write permission for storing tokens (DDR-048) and CSRF state (Risk 19D)
    this.oauthHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-access-token`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-user-id`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/oauth-csrf-state`,
        ],
      }),
    );

    const oauthIntegration = new integrations.HttpLambdaIntegration(
      'OAuthLambdaIntegration',
      this.oauthHandler,
    );

    // OAuth callback route: GET /oauth/callback (browser redirect from Meta)
    httpApi.addRoutes({
      path: '/oauth/callback',
      methods: [apigwv2.HttpMethod.GET],
      integration: oauthIntegration,
    });

    // Risk 19D: OAuth authorize endpoint — generates auth URL with CSRF state token.
    httpApi.addRoutes({
      path: '/oauth/authorize',
      methods: [apigwv2.HttpMethod.GET],
      integration: oauthIntegration,
    });

    // =========================================================================
    // CloudFront Distribution (DDR-044: HTTPS, DDoS protection)
    // =========================================================================
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain);

    const distribution = new cloudfront.Distribution(this, 'WebhookDistribution', {
      comment: 'AI Social Media Helper — Meta webhook notifications + Instagram OAuth callback',
      // Risk 16: Enforce TLS 1.2+ with TLS 1.3 AEAD cipher suites.
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: apiOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'WebhookDistributionDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront domain — Webhook: https://<domain>/webhook, OAuth: https://<domain>/oauth/callback',
    });

    new cdk.CfnOutput(this, 'WebhookDistributionId', {
      value: distribution.distributionId,
      description: 'Webhook CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'WebhookApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'Webhook API Gateway endpoint (direct, prefer CloudFront URL)',
    });

    new cdk.CfnOutput(this, 'WebhookLambdaName', {
      value: this.webhookHandler.functionName,
      description: 'Webhook Lambda function name',
    });

    new cdk.CfnOutput(this, 'OAuthLambdaName', {
      value: this.oauthHandler.functionName,
      description: 'OAuth Lambda function name (DDR-048)',
    });

    // ECR repo outputs are in RegistryStack (DDR-046)
  }
}
