import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BackendPipelineStackProps extends cdk.StackProps {
  /** Light ECR repository (API + Enhancement Lambdas, no ffmpeg) */
  lightEcrRepo: ecr.IRepository;
  /** Heavy ECR repository (Thumbnail + Selection + Video Lambdas, with ffmpeg) */
  heavyEcrRepo: ecr.IRepository;
  /** All 5 Lambda functions to update after build */
  apiHandler: lambda.IFunction;
  thumbnailProcessor: lambda.IFunction;
  selectionProcessor: lambda.IFunction;
  enhancementProcessor: lambda.IFunction;
  videoProcessor: lambda.IFunction;
  /** CodeStar connection ARN (DDR-028: parameterized, not hardcoded) */
  codeStarConnectionArn: string;
}

/**
 * BackendPipelineStack creates a CodePipeline that builds all 5 Lambda
 * container images and deploys them independently of the frontend (DDR-035).
 *
 * Pipeline stages:
 * 1. Source: GitHub main branch via CodeStar Connection
 * 2. Build: 5 Docker builds (2 light + 3 heavy) using parameterized Dockerfiles
 * 3. Deploy: Update all 5 Lambda functions with their specific image URIs
 *
 * Each Lambda gets its own container image with exactly one Go binary.
 * Docker layer caching means builds 2-5 reuse the Go module download
 * layer from build 1 (~30s saved per subsequent build).
 *
 * See docs/DOCKER-IMAGES.md for the full image strategy and layer sharing.
 */
export class BackendPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BackendPipelineStackProps) {
    super(scope, id, props);

    // --- Artifact Bucket ---
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `ai-social-media-be-artifacts-${this.account}`,
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
    const buildOutput = new codepipeline.Artifact('BackendBuildOutput');

    // --- Source Action ---
    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: 'GitHub',
      owner: 'francis-pang',
      repo: 'ai-social-media-helper',
      branch: 'main',
      connectionArn: props.codeStarConnectionArn,
      output: sourceOutput,
      triggerOnPush: false, // Enable once pipeline is tested
    });

    // --- Backend Build (5 Docker images) ---
    const lightRepoUri = props.lightEcrRepo.repositoryUri;
    const heavyRepoUri = props.heavyEcrRepo.repositoryUri;

    const backendBuild = new codebuild.PipelineProject(this, 'BackendBuild', {
      projectName: 'AiSocialMediaBackendBuild',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true, // Required for Docker-in-Docker
      },
      environmentVariables: {
        LIGHT_REPO_URI: { value: lightRepoUri },
        HEAVY_REPO_URI: { value: heavyRepoUri },
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
              // Go vulnerability scanning
              'go install golang.org/x/vuln/cmd/govulncheck@latest',
              'govulncheck ./... || echo "WARN: govulncheck found vulnerabilities (non-blocking)"',
            ],
          },
          build: {
            commands: [
              'COMMIT=${CODEBUILD_RESOLVED_SOURCE_VERSION:0:7}',

              // --- Light images (no ffmpeg) ---
              // Build 1: API Lambda
              'echo "Building API Lambda (light)..."',
              'docker build --build-arg CMD_TARGET=media-lambda -t $LIGHT_REPO_URI:api-$COMMIT -t $LIGHT_REPO_URI:api-latest -f cmd/media-lambda/Dockerfile.light .',

              // Build 2: Enhancement Lambda (reuses Go module cache from build 1)
              'echo "Building Enhancement Lambda (light)..."',
              'docker build --build-arg CMD_TARGET=enhance-lambda -t $LIGHT_REPO_URI:enhance-$COMMIT -t $LIGHT_REPO_URI:enhance-latest -f cmd/media-lambda/Dockerfile.light .',

              // --- Heavy images (with ffmpeg) ---
              // Build 3: Thumbnail Lambda
              'echo "Building Thumbnail Lambda (heavy)..."',
              'docker build --build-arg CMD_TARGET=thumbnail-lambda -t $HEAVY_REPO_URI:thumb-$COMMIT -t $HEAVY_REPO_URI:thumb-latest -f cmd/media-lambda/Dockerfile.heavy .',

              // Build 4: Selection Lambda (reuses Go module + ffmpeg cache from build 3)
              'echo "Building Selection Lambda (heavy)..."',
              'docker build --build-arg CMD_TARGET=selection-lambda -t $HEAVY_REPO_URI:select-$COMMIT -t $HEAVY_REPO_URI:select-latest -f cmd/media-lambda/Dockerfile.heavy .',

              // Build 5: Video Lambda (reuses Go module + ffmpeg cache from build 4)
              'echo "Building Video Lambda (heavy)..."',
              'docker build --build-arg CMD_TARGET=video-lambda -t $HEAVY_REPO_URI:video-$COMMIT -t $HEAVY_REPO_URI:video-latest -f cmd/media-lambda/Dockerfile.heavy .',
            ],
          },
          post_build: {
            commands: [
              // Push all images to ECR
              'echo "Pushing light images..."',
              'docker push $LIGHT_REPO_URI:api-$COMMIT',
              'docker push $LIGHT_REPO_URI:api-latest',
              'docker push $LIGHT_REPO_URI:enhance-$COMMIT',
              'docker push $LIGHT_REPO_URI:enhance-latest',

              'echo "Pushing heavy images..."',
              'docker push $HEAVY_REPO_URI:thumb-$COMMIT',
              'docker push $HEAVY_REPO_URI:thumb-latest',
              'docker push $HEAVY_REPO_URI:select-$COMMIT',
              'docker push $HEAVY_REPO_URI:select-latest',
              'docker push $HEAVY_REPO_URI:video-$COMMIT',
              'docker push $HEAVY_REPO_URI:video-latest',

              // Write image URIs for deploy stage
              `echo '{"apiImage":"'$LIGHT_REPO_URI:api-$COMMIT'","enhanceImage":"'$LIGHT_REPO_URI:enhance-$COMMIT'","thumbImage":"'$HEAVY_REPO_URI:thumb-$COMMIT'","selectImage":"'$HEAVY_REPO_URI:select-$COMMIT'","videoImage":"'$HEAVY_REPO_URI:video-$COMMIT'"}' > imageDetail.json`,
            ],
          },
        },
        artifacts: {
          files: ['imageDetail.json'],
        },
      }),
    });

    // Grant CodeBuild permission to push images to both ECR repos
    props.lightEcrRepo.grantPullPush(backendBuild);
    props.heavyEcrRepo.grantPullPush(backendBuild);

    backendBuild.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // --- Deploy (update all 5 Lambda functions) ---
    const allLambdas = [
      { name: props.apiHandler.functionName, imageKey: 'apiImage' },
      { name: props.enhancementProcessor.functionName, imageKey: 'enhanceImage' },
      { name: props.thumbnailProcessor.functionName, imageKey: 'thumbImage' },
      { name: props.selectionProcessor.functionName, imageKey: 'selectImage' },
      { name: props.videoProcessor.functionName, imageKey: 'videoImage' },
    ];

    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: 'AiSocialMediaBackendDeploy',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: [
              // Parse image URIs from build output
              'export API_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'apiImage\'])")',
              'export ENHANCE_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'enhanceImage\'])")',
              'export THUMB_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'thumbImage\'])")',
              'export SELECT_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'selectImage\'])")',
              'export VIDEO_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'videoImage\'])")',

              // Update each Lambda with its specific image
              ...allLambdas.map(({ name, imageKey }) => {
                const envVar = imageKey.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
                return `echo "Updating ${name}..." && aws lambda update-function-code --function-name ${name} --image-uri $${envVar}`;
              }),

              // Wait for all function updates to complete
              ...allLambdas.map(({ name }) =>
                `aws lambda wait function-updated --function-name ${name}`,
              ),
            ],
          },
        },
      }),
    });

    // The deploy commands use variable env vars, so build them more explicitly
    // Override the buildspec with cleaner commands
    const deployCfn = deployProject.node.defaultChild as cdk.CfnResource;
    deployCfn.addPropertyOverride('Source.BuildSpec', JSON.stringify({
      version: '0.2',
      phases: {
        build: {
          commands: [
            'export API_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'apiImage\'])")',
            'export ENHANCE_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'enhanceImage\'])")',
            'export THUMB_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'thumbImage\'])")',
            'export SELECT_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'selectImage\'])")',
            'export VIDEO_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'videoImage\'])")',

            `echo "Updating ${props.apiHandler.functionName}..." && aws lambda update-function-code --function-name ${props.apiHandler.functionName} --image-uri $API_IMAGE`,
            `echo "Updating ${props.enhancementProcessor.functionName}..." && aws lambda update-function-code --function-name ${props.enhancementProcessor.functionName} --image-uri $ENHANCE_IMAGE`,
            `echo "Updating ${props.thumbnailProcessor.functionName}..." && aws lambda update-function-code --function-name ${props.thumbnailProcessor.functionName} --image-uri $THUMB_IMAGE`,
            `echo "Updating ${props.selectionProcessor.functionName}..." && aws lambda update-function-code --function-name ${props.selectionProcessor.functionName} --image-uri $SELECT_IMAGE`,
            `echo "Updating ${props.videoProcessor.functionName}..." && aws lambda update-function-code --function-name ${props.videoProcessor.functionName} --image-uri $VIDEO_IMAGE`,

            `aws lambda wait function-updated --function-name ${props.apiHandler.functionName}`,
            `aws lambda wait function-updated --function-name ${props.enhancementProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.thumbnailProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.selectionProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.videoProcessor.functionName}`,
          ],
        },
      },
    }));

    // Grant deploy project permissions for all Lambda updates
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction'],
        resources: [
          props.apiHandler.functionArn,
          props.thumbnailProcessor.functionArn,
          props.selectionProcessor.functionArn,
          props.enhancementProcessor.functionArn,
          props.videoProcessor.functionArn,
        ],
      }),
    );

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

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: artifactBucket.bucketName,
      description: 'Backend pipeline artifacts S3 bucket name',
    });
  }
}
