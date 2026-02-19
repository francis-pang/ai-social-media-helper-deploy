import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface FrontendPipelineStackProps extends cdk.StackProps {
  /** Frontend S3 bucket to deploy SPA build output to */
  frontendBucket: s3.IBucket;
  /** CloudFront distribution to invalidate after deploy */
  distribution: cloudfront.IDistribution;
  /** CodeStar connection ARN (DDR-028: parameterized, not hardcoded) */
  codeStarConnectionArn: string;
  /** Cognito User Pool ID — passed to frontend build as VITE_COGNITO_USER_POOL_ID */
  cognitoUserPoolId: string;
  /** Cognito User Pool Client ID — passed to frontend build as VITE_COGNITO_CLIENT_ID */
  cognitoClientId: string;
  /** Pipeline artifacts S3 bucket (from StorageStack — DDR-045: stateful/stateless split) */
  artifactBucket: s3.IBucket;
}

/**
 * FrontendPipelineStack creates a CodePipeline that builds and deploys the
 * Preact SPA independently of the backend (DDR-035).
 *
 * Pipeline stages:
 * 1. Source: GitHub main branch via CodeStar Connection
 * 2. Build: Preact SPA (Node 22, npm ci, npm run build)
 * 3. Deploy: S3 sync + CloudFront invalidation
 *
 * Frontend-only changes (CSS, component logic, copy) do not trigger
 * Docker builds or Lambda updates.
 */
export class FrontendPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontendPipelineStackProps) {
    super(scope, id, props);

    // Artifact bucket from StorageStack (DDR-045: stateful/stateless split)
    const artifactBucket = props.artifactBucket;

    // --- Artifacts ---
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('FrontendBuildOutput');

    // --- Source Action ---
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: 'francis-pang',
      repo: 'ai-social-media-helper',
      branch: 'main',
      connectionArn: props.codeStarConnectionArn,
      output: sourceOutput,
      triggerOnPush: true, // A4: CodeStar native trigger — GitHub Actions handles selective stop
    });

    // --- Frontend Build ---
    const frontendBuild = new codebuild.PipelineProject(this, 'FrontendBuild', {
      projectName: 'AiSocialMediaFrontendBuild',
      description: 'Build Preact SPA with Vite (Node 22, npm ci, npm run build) and inject Cognito config',
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        VITE_CLOUD_MODE: { value: '1' },
        VITE_COGNITO_USER_POOL_ID: { value: props.cognitoUserPoolId },
        VITE_COGNITO_CLIENT_ID: { value: props.cognitoClientId },
        // DDR-062: Inject commit hash into frontend build for version identity.
        // CODEBUILD_RESOLVED_SOURCE_VERSION is the full 40-char SHA; truncated to 7 chars in build.
        VITE_COMMIT_HASH: { value: 'dev' }, // Overridden by build command below
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': { nodejs: '22' },
            commands: ['cd $CODEBUILD_SRC_DIR/web/frontend && npm ci'],
          },
          build: {
            commands: [
              // DDR-062: Inject 7-char commit hash into frontend build via Vite env var.
              'export VITE_COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-7)',
              'cd $CODEBUILD_SRC_DIR/web/frontend && npm audit --audit-level=high || echo "WARN: npm audit found vulnerabilities (non-blocking)"',
              'cd $CODEBUILD_SRC_DIR/web/frontend && npm run build',
            ],
          },
        },
        artifacts: {
          'base-directory': 'web/frontend/dist',
          files: ['**/*'],
        },
      }),
    });

    // --- Deploy (S3 sync + CloudFront invalidation) ---
    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: 'AiSocialMediaFrontendDeploy',
      description: 'Invalidate CloudFront cache after S3 deployment to serve latest SPA build',
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        DISTRIBUTION_ID: { value: props.distribution.distributionId },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              'echo "Invalidating CloudFront distribution $DISTRIBUTION_ID..."',
              'aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths "/*"',
            ],
          },
        },
      }),
    });

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
      pipelineName: 'AiSocialMediaFrontendPipeline',
      artifactBucket,
      restartExecutionOnUpdate: false,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'BuildFrontend',
          project: frontendBuild,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.S3DeployAction({
          actionName: 'DeployToS3',
          bucket: props.frontendBucket,
          input: buildOutput,
          runOrder: 1,
        }),
        new codepipeline_actions.CodeBuildAction({
          actionName: 'InvalidateCloudFront',
          project: deployProject,
          input: buildOutput,
          runOrder: 2,
        }),
      ],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'FrontendPipelineName', {
      value: pipeline.pipelineName,
      description: 'Frontend CodePipeline name',
    });
  }
}
