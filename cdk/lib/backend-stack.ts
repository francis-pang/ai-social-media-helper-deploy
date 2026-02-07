import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as path from 'path';
import { Construct } from 'constructs';

export interface BackendStackProps extends cdk.StackProps {
  /** The S3 bucket for media uploads (from StorageStack) */
  mediaBucket: s3.IBucket;
}

/**
 * BackendStack creates Lambda + API Gateway HTTP API for the backend.
 *
 * Deploys a container image Lambda (DDR-027) that bundles the Go binary
 * alongside ffmpeg and ffprobe for video processing. This replaces the
 * previous zip-based deployment (DDR-026) to enable video triage in Lambda.
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

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

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

    // --- Lambda Function (Container Image) ---
    // Container image bundles Go binary + static ffmpeg/ffprobe (DDR-027).
    // For initial CDK deploy (before pipeline pushes the first image), we use
    // a placeholder from the application repo's Dockerfile.
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

    // --- API Gateway HTTP API ---
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'AiSocialMediaApi',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'], // Tightened to CloudFront domain once known
        maxAge: cdk.Duration.hours(1),
      },
    });

    // Route all /api/* requests to the Lambda function
    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      this.handler,
    );

    this.httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
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
  }
}
