import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { createBackendBuildProject } from './constructs/backend-build-project.js';
import { createBackendDeployProject } from './constructs/backend-deploy-project.js';

export interface BackendPipelineStackProps extends cdk.StackProps {
  /** ECR Private light repository (API Lambda — proprietary code, DDR-041) */
  lightEcrRepo: ecr.IRepository;
  /** ECR Private heavy repository (Selection Lambda — proprietary code, DDR-041) */
  heavyEcrRepo: ecr.IRepository;
  /** ECR Public light repository name (Enhancement Lambda — generic code, DDR-041) */
  publicLightRepoName: string;
  /** ECR Public heavy repository name (Thumbnail + Video Lambdas — generic code, DDR-041) */
  publicHeavyRepoName: string;
  /** All Lambda functions to update after build (DDR-053: 11 total) */
  apiHandler: lambda.IFunction;
  triageProcessor: lambda.IFunction;
  descriptionProcessor: lambda.IFunction;
  downloadProcessor: lambda.IFunction;
  publishProcessor: lambda.IFunction;
  thumbnailProcessor: lambda.IFunction;
  selectionProcessor: lambda.IFunction;
  enhancementProcessor: lambda.IFunction;
  videoProcessor: lambda.IFunction;
  /** MediaProcess Lambda (DDR-061) */
  mediaProcessProcessor: lambda.IFunction;
  /** ECR Private repository for webhook Lambda image (DDR-044) */
  webhookEcrRepo: ecr.IRepository;
  /** Webhook Lambda function to update after build (DDR-044) */
  webhookHandler: lambda.IFunction;
  /** ECR Private repository for OAuth Lambda image (DDR-048) */
  oauthEcrRepo: ecr.IRepository;
  /** OAuth Lambda function to update after build (DDR-048) */
  oauthHandler: lambda.IFunction;
  /** CodeStar connection ARN (DDR-028: parameterized, not hardcoded) */
  codeStarConnectionArn: string;
  /** Pipeline artifacts S3 bucket (from StorageStack — DDR-045: stateful/stateless split) */
  artifactBucket: s3.IBucket;
}

/**
 * BackendPipelineStack creates a CodePipeline that builds all 11 Lambda
 * container images and deploys them independently of the frontend (DDR-035, DDR-044, DDR-048, DDR-053).
 *
 * Container Registry Strategy (DDR-041, DDR-044, DDR-048):
 * - ECR Private: API + Triage + Description + Download + Publish + Selection (heavy) + Webhook + OAuth — proprietary code
 * - ECR Public: Enhancement (light) + Thumbnail + Video (heavy) — generic code
 *
 * Pipeline stages:
 * 1. Source: GitHub main branch via CodeStar Connection
 * 2. Build: 11 Docker builds — 8 to ECR Private, 3 to ECR Public
 * 3. Deploy: Update all 11 Lambda functions with their specific image URIs
 *
 * Each Lambda gets its own container image with exactly one Go binary.
 * Docker layer caching means subsequent builds reuse the Go module download
 * layer (~30s saved per subsequent build).
 *
 * See docs/DOCKER-IMAGES.md for the full image strategy and layer sharing.
 */
export class BackendPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BackendPipelineStackProps) {
    super(scope, id, props);

    // Artifact bucket from StorageStack (DDR-045: stateful/stateless split)
    const artifactBucket = props.artifactBucket;

    // --- Artifacts ---
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BackendBuildOutput');

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

    // --- Backend Build (11 Docker images: 8 private + 3 public, DDR-053) ---
    const backendBuild = createBackendBuildProject(this, 'BackendBuild', {
      lightEcrRepo: props.lightEcrRepo,
      heavyEcrRepo: props.heavyEcrRepo,
      webhookEcrRepo: props.webhookEcrRepo,
      oauthEcrRepo: props.oauthEcrRepo,
      publicLightRepoName: props.publicLightRepoName,
      publicHeavyRepoName: props.publicHeavyRepoName,
      artifactBucket,
      account: this.account,
      region: this.region,
    });

    // --- Deploy (update all Lambda functions, DDR-053, DDR-061) ---
    const deployLambdas = [
      { functionName: props.apiHandler.functionName, functionArn: props.apiHandler.functionArn, imageKey: 'apiImage' },
      { functionName: props.triageProcessor.functionName, functionArn: props.triageProcessor.functionArn, imageKey: 'triageImage' },
      { functionName: props.descriptionProcessor.functionName, functionArn: props.descriptionProcessor.functionArn, imageKey: 'descImage' },
      { functionName: props.downloadProcessor.functionName, functionArn: props.downloadProcessor.functionArn, imageKey: 'downloadImage' },
      { functionName: props.publishProcessor.functionName, functionArn: props.publishProcessor.functionArn, imageKey: 'publishImage' },
      { functionName: props.enhancementProcessor.functionName, functionArn: props.enhancementProcessor.functionArn, imageKey: 'enhanceImage' },
      { functionName: props.thumbnailProcessor.functionName, functionArn: props.thumbnailProcessor.functionArn, imageKey: 'thumbImage' },
      { functionName: props.selectionProcessor.functionName, functionArn: props.selectionProcessor.functionArn, imageKey: 'selectImage' },
      { functionName: props.videoProcessor.functionName, functionArn: props.videoProcessor.functionArn, imageKey: 'videoImage' },
      { functionName: props.mediaProcessProcessor.functionName, functionArn: props.mediaProcessProcessor.functionArn, imageKey: 'mediaprocessImage' },
      { functionName: props.webhookHandler.functionName, functionArn: props.webhookHandler.functionArn, imageKey: 'webhookImage' },
      { functionName: props.oauthHandler.functionName, functionArn: props.oauthHandler.functionArn, imageKey: 'oauthImage' },
    ];

    const deployProject = createBackendDeployProject(this, 'DeployProject', {
      lambdas: deployLambdas,
      account: this.account,
      region: this.region,
    });

    // --- Pipeline ---
    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'AiSocialMediaBackendPipeline',
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
          actionName: 'BuildImages',
          project: backendBuild,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'UpdateLambdas',
          project: deployProject,
          input: buildOutput,
        }),
      ],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'BackendPipelineName', {
      value: pipeline.pipelineName,
      description: 'Backend CodePipeline name',
    });

    // Artifact bucket output moved to StorageStack (DDR-045)
  }
}
