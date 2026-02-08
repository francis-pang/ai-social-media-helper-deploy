import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as path from 'path';
import { Construct } from 'constructs';

export interface BackendStackProps extends cdk.StackProps {
  /** The S3 bucket for media uploads (from StorageStack) */
  mediaBucket: s3.IBucket;
  /** CloudFront distribution domain for CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
}

/**
 * BackendStack creates Lambda + API Gateway HTTP API for the backend.
 *
 * Security hardening (DDR-028):
 * - Cognito User Pool with JWT authorizer (no public signup)
 * - Origin-verify shared secret (CloudFront → Lambda)
 * - CORS locked to CloudFront domain
 * - API Gateway default throttling (100 req/s burst, 50 req/s steady)
 *
 * Deploys a container image Lambda (DDR-027) that bundles the Go binary
 * alongside ffmpeg and ffprobe for video processing.
 *
 * Lambda execution role has:
 * - s3:GetObject, s3:PutObject, s3:DeleteObject, s3:ListBucket on the media bucket
 * - ssm:GetParameter for reading the Gemini API key from Parameter Store
 * - CloudWatch Logs access (automatic via CDK)
 */
export class BackendStack extends cdk.Stack {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly handler: lambda.DockerImageFunction;
  public readonly ecrRepository: ecr.Repository;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    // --- Cognito User Pool (DDR-028 Problem 2) ---
    // Self-signup disabled — the sole user is provisioned via AWS CLI:
    //   aws cognito-idp admin-create-user --user-pool-id <id> --username <email>
    //   aws cognito-idp admin-set-user-password --user-pool-id <id> --username <email> --password <pw> --permanent
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'AiSocialMediaUsers',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'AiSocialMediaWebClient',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // SPA cannot keep a secret
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(7),
    });

    // --- ECR Repository ---
    // Stores container images for the Lambda function.
    // Lifecycle rule keeps only the last 5 images to control storage costs.
    this.ecrRepository = new ecr.Repository(this, 'LambdaImageRepo', {
      repositoryName: 'ai-social-media-lambda',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: 5,
          description: 'Keep only the last 5 images',
        },
      ],
    });

    // --- Origin Verify Secret (DDR-028 Problem 1) ---
    // A shared secret passed by CloudFront via custom origin header,
    // verified by Lambda middleware to block direct API Gateway access.
    // Generate once and store in SSM for rotation if needed.
    const originVerifySecret = cdk.Fn.select(2, cdk.Fn.split('/', this.stackId));

    // --- Lambda Function (Container Image) ---
    // Container image bundles Go binary + static ffmpeg/ffprobe (DDR-027).
    this.handler = new lambda.DockerImageFunction(this, 'ApiHandler', {
      functionName: 'AiSocialMediaApiHandler',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../.build/lambda'),
      ),
      timeout: cdk.Duration.minutes(5), // Triage can take several minutes
      memorySize: 2048, // ffmpeg needs CPU; Lambda allocates CPU proportional to memory (DDR-027)
      ephemeralStorageSize: cdk.Size.mebibytes(2048), // /tmp for S3 downloads + video compression
      environment: {
        MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
        SSM_API_KEY_PARAM: '/ai-social-media/prod/gemini-api-key',
        ORIGIN_VERIFY_SECRET: originVerifySecret,
      },
    });

    // Grant Lambda read/write/delete + list access to the media bucket
    props.mediaBucket.grantReadWrite(this.handler);
    props.mediaBucket.grantDelete(this.handler);

    // Grant Lambda read access to SSM Parameter Store for Gemini API key
    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/gemini-api-key`,
        ],
      }),
    );

    // --- JWT Authorizer (DDR-028 Problem 2) ---
    const issuer = this.userPool.userPoolProviderUrl;
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('CognitoAuthorizer', issuer, {
      jwtAudience: [this.userPoolClient.userPoolClientId],
      identitySource: ['$request.header.Authorization'],
    });

    // --- API Gateway HTTP API (DDR-028: CORS lockdown + throttling) ---
    // CORS locked to CloudFront domain. Direct API Gateway access is rejected
    // by the origin-verify middleware in Lambda anyway, but defense-in-depth.
    const allowedOrigins = props.cloudFrontDomain
      ? [`https://${props.cloudFrontDomain}`]
      : ['*']; // Fallback for initial deploy before CloudFront domain is known

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'AiSocialMediaApi',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: allowedOrigins,
        maxAge: cdk.Duration.hours(1),
      },
    });

    // --- API Gateway Throttling (DDR-028 Problem 10) ---
    // Default stage throttling: 100 burst, 50 steady-state req/s.
    // Free — built into API Gateway. WAF deferred per DDR-028.
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild as cdk.CfnResource;
    if (cfnStage) {
      cfnStage.addPropertyOverride('DefaultRouteSettings', {
        ThrottlingBurstLimit: 100,
        ThrottlingRateLimit: 50,
      });
    }

    // Route all /api/* requests to the Lambda function with JWT auth
    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      this.handler,
    );

    this.httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
      authorizer: jwtAuthorizer,
    });

    // Health endpoint without auth (for monitoring/uptime checks)
    this.httpApi.addRoutes({
      path: '/api/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'API Gateway HTTP API endpoint URL',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: this.handler.functionName,
      description: 'Lambda function name',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: this.handler.functionArn,
      description: 'Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repositoryUri,
      description: 'ECR repository URI for Lambda container images',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID (for admin-create-user)',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID (for frontend auth)',
    });

    new cdk.CfnOutput(this, 'OriginVerifySecret', {
      value: originVerifySecret,
      description: 'Origin verify shared secret (set on CloudFront custom header)',
    });
  }
}
