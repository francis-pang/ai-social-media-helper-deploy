import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

/**
 * WebhookStack creates a fully isolated infrastructure for receiving
 * Meta/Instagram webhook notifications (DDR-044).
 *
 * Components:
 * - ECR Private repository for the webhook Lambda image
 * - Lightweight Lambda function (128 MB, 10s timeout)
 * - API Gateway HTTP API (no auth, server-to-server)
 * - CloudFront distribution (HTTPS, DDoS protection)
 *
 * This stack has NO dependencies on BackendStack, StorageStack, or
 * FrontendStack. The webhook Lambda only needs SSM read access for
 * the verify token and app secret.
 *
 * Security model:
 * - No JWT auth (Meta cannot authenticate with Cognito)
 * - No origin-verify (requests come from Meta, not CloudFront SPA)
 * - HMAC-SHA256 signature verification on POST payloads (in Lambda code)
 * - API Gateway throttling (10 burst / 5 steady)
 */
export class WebhookStack extends cdk.Stack {
  /** ECR repository for the webhook Lambda image (used by pipeline) */
  public readonly webhookEcrRepo: ecr.IRepository;
  /** Webhook Lambda function (used by pipeline for deployment) */
  public readonly webhookHandler: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // ECR Repository (DDR-044)
    // =========================================================================
    // The ECR repo must be created before the first deploy (with an initial
    // image pushed) because DockerImageFunction requires a valid image at
    // creation time. Create it via:
    //   aws ecr create-repository --repository-name ai-social-media-webhook
    //   docker build --build-arg CMD_TARGET=webhook-lambda -t <uri>:webhook-latest -f cmd/media-lambda/Dockerfile.light .
    //   docker push <uri>:webhook-latest
    this.webhookEcrRepo = ecr.Repository.fromRepositoryName(
      this, 'WebhookImageRepo', 'ai-social-media-webhook',
    );

    // =========================================================================
    // Lambda Function (DDR-044: 128 MB, 10s, ECR Private)
    // =========================================================================
    this.webhookHandler = new lambda.DockerImageFunction(this, 'WebhookHandler', {
      code: lambda.DockerImageCode.fromEcr(this.webhookEcrRepo, { tagOrDigest: 'webhook-latest' }),
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
      // No CORS — server-to-server from Meta
    });

    // Throttling: 10 burst / 5 steady (webhook traffic is low)
    const cfnStage = httpApi.defaultStage?.node.defaultChild as cdk.CfnResource;
    if (cfnStage) {
      cfnStage.addPropertyOverride('DefaultRouteSettings', {
        ThrottlingBurstLimit: 10,
        ThrottlingRateLimit: 5,
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
    // CloudFront Distribution (DDR-044: HTTPS, DDoS protection)
    // =========================================================================
    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', httpApi.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain);

    const distribution = new cloudfront.Distribution(this, 'WebhookDistribution', {
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
      description: 'Webhook CloudFront domain — use as Meta Callback URL: https://<domain>/webhook',
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

    new cdk.CfnOutput(this, 'WebhookEcrRepoUri', {
      value: this.webhookEcrRepo.repositoryUri,
      description: 'Webhook ECR repository URI',
    });
  }
}
