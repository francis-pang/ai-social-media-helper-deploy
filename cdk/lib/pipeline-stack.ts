import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface PipelineStackProps extends cdk.StackProps {
  /** Frontend S3 bucket to deploy SPA build output to */
  frontendBucket: s3.IBucket;
  /** CloudFront distribution to invalidate after deploy */
  distribution: cloudfront.IDistribution;
  /** Lambda function to update with new Go binary */
  lambdaFunction: lambda.IFunction;
}

/**
 * PipelineStack creates a CodePipeline CI/CD pipeline that:
 *
 * 1. Source: Pulls from GitHub main branch via CodeStar Connection
 * 2. Build (parallel): Compiles Go Lambda binary + builds Preact SPA
 * 3. Deploy: Syncs SPA to S3, updates Lambda code, invalidates CloudFront
 *
 * triggerOnPush is disabled initially since cmd/media-lambda doesn't exist yet.
 * Enable it once the Go Lambda entry point is committed.
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    // --- Artifact Bucket (7-day lifecycle for pipeline/build artifacts) ---
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `ai-social-media-artifacts-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(7),
          id: 'expire-artifacts-7d',
        },
      ],
    });

    // --- Artifacts ---
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const backendBuildOutput = new codepipeline.Artifact('BackendBuildOutput');
    const frontendBuildOutput = new codepipeline.Artifact('FrontendBuildOutput');

    // --- Source Action (GitHub via CodeStar Connection) ---
    // Connection created manually in AWS Console (one-time OAuth handshake).
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: 'francis-pang',
      repo: 'ai-social-media-helper',
      branch: 'main',
      connectionArn:
        'arn:aws:codeconnections:us-east-1:123456789012:connection/YOUR_CONNECTION_ID',
      output: sourceOutput,
      triggerOnPush: false, // Disabled until cmd/media-lambda exists
    });

    // --- Backend Build (Go Lambda binary) ---
    // Installs Go 1.24 (project requirement) since CodeBuild standard:7.0 only ships 1.21/1.22.
    const backendBuild = new codebuild.PipelineProject(this, 'BackendBuild', {
      projectName: 'AiSocialMediaBackendBuild',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'curl -sLO https://go.dev/dl/go1.24.0.linux-amd64.tar.gz',
              'rm -rf /usr/local/go && tar -C /usr/local -xzf go1.24.0.linux-amd64.tar.gz',
              'export PATH=/usr/local/go/bin:$PATH',
              'go version',
            ],
          },
          build: {
            commands: [
              'export PATH=/usr/local/go/bin:$PATH',
              'GOARCH=amd64 GOOS=linux CGO_ENABLED=0 go build -o bootstrap ./cmd/media-lambda',
              'zip function.zip bootstrap',
            ],
          },
        },
        artifacts: {
          files: ['function.zip'],
        },
      }),
    });

    // --- Frontend Build (Preact SPA) ---
    const frontendBuild = new codebuild.PipelineProject(this, 'FrontendBuild', {
      projectName: 'AiSocialMediaFrontendBuild',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: '22' },
            commands: ['cd web/frontend && npm ci'],
          },
          build: {
            commands: ['cd web/frontend && npm run build'],
          },
        },
        artifacts: {
          'base-directory': 'web/frontend/dist',
          files: ['**/*'],
        },
      }),
    });

    // --- Deploy Project (Lambda code update + CloudFront invalidation) ---
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: 'AiSocialMediaDeploy',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        LAMBDA_FUNCTION_NAME: { value: props.lambdaFunction.functionName },
        DISTRIBUTION_ID: { value: props.distribution.distributionId },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              // Update Lambda function code with the Go binary
              'echo "Updating Lambda function $LAMBDA_FUNCTION_NAME..."',
              'aws lambda update-function-code --function-name $LAMBDA_FUNCTION_NAME --zip-file fileb://function.zip',
              // Wait for the function update to complete
              'aws lambda wait function-updated --function-name $LAMBDA_FUNCTION_NAME',
              // Invalidate CloudFront cache
              'echo "Invalidating CloudFront distribution $DISTRIBUTION_ID..."',
              'aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths "/*"',
            ],
          },
        },
      }),
    });

    // Grant deploy project permissions for Lambda update and CloudFront invalidation
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
        resources: [props.lambdaFunction.functionArn],
      }),
    );
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${props.distribution.distributionId}`,
        ],
      }),
    );

    // --- Pipeline ---
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'AiSocialMediaPipeline',
      artifactBucket,
      restartExecutionOnUpdate: false,
    });

    // Stage 1: Source
    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    // Stage 2: Build (parallel — both run at runOrder 1)
    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'BackendBuild',
          project: backendBuild,
          input: sourceOutput,
          outputs: [backendBuildOutput],
        }),
        new codepipeline_actions.CodeBuildAction({
          actionName: 'FrontendBuild',
          project: frontendBuild,
          input: sourceOutput,
          outputs: [frontendBuildOutput],
        }),
      ],
    });

    // Stage 3: Deploy (S3 first, then Lambda + CloudFront)
    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        // Sync frontend build output to S3
        new codepipeline_actions.S3DeployAction({
          actionName: 'DeployFrontend',
          bucket: props.frontendBucket,
          input: frontendBuildOutput,
          runOrder: 1,
        }),
        // Update Lambda code and invalidate CloudFront (after S3 sync)
        new codepipeline_actions.CodeBuildAction({
          actionName: 'DeployBackend',
          project: deployProject,
          input: backendBuildOutput,
          runOrder: 2,
        }),
      ],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipelineName,
      description: 'CodePipeline name',
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: artifactBucket.bucketName,
      description: 'Pipeline artifacts S3 bucket name',
    });
  }
}
