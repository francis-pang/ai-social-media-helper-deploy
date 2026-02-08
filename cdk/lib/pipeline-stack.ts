import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
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
  /** Lambda function to update with new container image */
  lambdaFunction: lambda.IFunction;
  /** ECR repository for Lambda container images (from BackendStack) */
  ecrRepository: ecr.IRepository;
  /** CodeStar connection ARN (DDR-028: parameterized, not hardcoded) */
  codeStarConnectionArn: string;
}

/**
 * PipelineStack creates a CodePipeline CI/CD pipeline that:
 *
 * 1. Source: Pulls from GitHub main branch via CodeStar Connection
 * 2. Build (parallel): Builds Docker container image + builds Preact SPA
 * 3. Deploy: Syncs SPA to S3, updates Lambda with new container image, invalidates CloudFront
 *
 * The backend build uses Docker to build the container image (DDR-027) which
 * bundles the Go binary with ffmpeg/ffprobe for video processing support.
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
    // ARN is parameterized via environment variable (DDR-028 Problem 15).
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: 'francis-pang',
      repo: 'ai-social-media-helper',
      branch: 'main',
      connectionArn: props.codeStarConnectionArn,
      output: sourceOutput,
      triggerOnPush: false, // Disabled until cmd/media-lambda exists
    });

    // --- Backend Build (Docker container image) ---
    // Builds the container image from cmd/media-lambda/Dockerfile (DDR-027)
    // and pushes it to ECR. Requires privileged mode for Docker-in-Docker.
    const ecrRepoUri = props.ecrRepository.repositoryUri;

    const backendBuild = new codebuild.PipelineProject(this, 'BackendBuild', {
      projectName: 'AiSocialMediaBackendBuild',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM, // Docker builds need more resources
        privileged: true, // Required for Docker-in-Docker
      },
      environmentVariables: {
        ECR_REPO_URI: { value: ecrRepoUri },
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_REGION_NAME: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              // Authenticate with ECR
              'aws ecr get-login-password --region $AWS_REGION_NAME | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION_NAME.amazonaws.com',
              // Dependency vulnerability scanning (DDR-028 Problem 15)
              'go install golang.org/x/vuln/cmd/govulncheck@latest',
              'govulncheck ./... || echo "WARN: govulncheck found vulnerabilities (non-blocking)"',
            ],
          },
          build: {
            commands: [
              // Build the container image using the Dockerfile in cmd/media-lambda/
              'docker build -t $ECR_REPO_URI:latest -f cmd/media-lambda/Dockerfile .',
              // Tag with the commit hash for traceability
              'docker tag $ECR_REPO_URI:latest $ECR_REPO_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
            ],
          },
          post_build: {
            commands: [
              // Push both tags to ECR
              'docker push $ECR_REPO_URI:latest',
              'docker push $ECR_REPO_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION',
              // Write the image URI to a file for the deploy stage
              'echo "{\"imageUri\":\"$ECR_REPO_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION\"}" > imageDetail.json',
            ],
          },
        },
        artifacts: {
          files: ['imageDetail.json'],
        },
      }),
    });

    // Grant CodeBuild permission to push images to ECR
    props.ecrRepository.grantPullPush(backendBuild);

    // Grant CodeBuild permission to get ECR authorization token
    backendBuild.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

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
            commands: [
              // Dependency vulnerability scanning (DDR-028 Problem 15)
              'cd web/frontend && npm audit --audit-level=high || echo "WARN: npm audit found vulnerabilities (non-blocking)"',
              'cd web/frontend && npm run build',
            ],
          },
        },
        artifacts: {
          'base-directory': 'web/frontend/dist',
          files: ['**/*'],
        },
      }),
    });

    // --- Deploy Project (Lambda image update + CloudFront invalidation) ---
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
              // Read the image URI from the backend build output
              'export IMAGE_URI=$(cat imageDetail.json | python3 -c "import sys,json; print(json.load(sys.stdin)[\'imageUri\'])")',
              // Update Lambda function code with the new container image
              'echo "Updating Lambda function $LAMBDA_FUNCTION_NAME with image $IMAGE_URI..."',
              'aws lambda update-function-code --function-name $LAMBDA_FUNCTION_NAME --image-uri $IMAGE_URI',
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
        // Update Lambda with new container image and invalidate CloudFront (after S3 sync)
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
