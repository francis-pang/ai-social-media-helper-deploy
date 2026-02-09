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
  /** ECR Private light repository (API Lambda — proprietary code, DDR-041) */
  lightEcrRepo: ecr.IRepository;
  /** ECR Private heavy repository (Selection Lambda — proprietary code, DDR-041) */
  heavyEcrRepo: ecr.IRepository;
  /** ECR Public light repository name (Enhancement Lambda — generic code, DDR-041) */
  publicLightRepoName: string;
  /** ECR Public heavy repository name (Thumbnail + Video Lambdas — generic code, DDR-041) */
  publicHeavyRepoName: string;
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
 * Container Registry Strategy (DDR-041):
 * - ECR Private: API (light) + Selection (heavy) — proprietary code
 * - ECR Public: Enhancement (light) + Thumbnail + Video (heavy) — generic code
 *
 * Pipeline stages:
 * 1. Source: GitHub main branch via CodeStar Connection
 * 2. Build: 5 Docker builds — 2 to ECR Private, 3 to ECR Public
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

    // --- Backend Build (5 Docker images: 2 private + 3 public) ---
    // ECR Private repo URIs (account-specific)
    const privateLight = props.lightEcrRepo.repositoryUri;
    const privateHeavy = props.heavyEcrRepo.repositoryUri;
    // ECR Public repo URIs (public.ecr.aws/<alias>/<repo-name>)
    // The public registry alias is resolved after the first push. We construct
    // the URI at build time using the AWS CLI to fetch the registry alias.
    const publicLightName = props.publicLightRepoName;
    const publicHeavyName = props.publicHeavyRepoName;

    const backendBuild = new codebuild.PipelineProject(this, 'BackendBuild', {
      projectName: 'AiSocialMediaBackendBuild',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true, // Required for Docker-in-Docker
      },
      environmentVariables: {
        PRIVATE_LIGHT_URI: { value: privateLight },
        PRIVATE_HEAVY_URI: { value: privateHeavy },
        PUBLIC_LIGHT_NAME: { value: publicLightName },
        PUBLIC_HEAVY_NAME: { value: publicHeavyName },
        AWS_ACCOUNT_ID: { value: this.account },
        AWS_REGION_NAME: { value: this.region },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              golang: '1.24',
            },
          },
          pre_build: {
            commands: [
              // Authenticate with ECR Private
              'aws ecr get-login-password --region $AWS_REGION_NAME | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION_NAME.amazonaws.com',
              // Authenticate with ECR Public (always us-east-1, DDR-041)
              'aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws',
              // Resolve ECR Public registry alias for URI construction
              'export PUBLIC_ALIAS=$(aws ecr-public describe-registries --region us-east-1 --query "registries[0].aliases[0].name" --output text)',
              'export PUBLIC_LIGHT_URI=public.ecr.aws/$PUBLIC_ALIAS/$PUBLIC_LIGHT_NAME',
              'export PUBLIC_HEAVY_URI=public.ecr.aws/$PUBLIC_ALIAS/$PUBLIC_HEAVY_NAME',
              'echo "ECR Public alias: $PUBLIC_ALIAS"',
              'echo "Public light URI: $PUBLIC_LIGHT_URI"',
              'echo "Public heavy URI: $PUBLIC_HEAVY_URI"',
              // Go vulnerability scanning
              'go install golang.org/x/vuln/cmd/govulncheck@latest',
              'govulncheck ./... || echo "WARN: govulncheck found vulnerabilities (non-blocking)"',
            ],
          },
          build: {
            commands: [
              'COMMIT=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-7)',

              // --- ECR Private: Light images (proprietary, no ffmpeg) ---
              // Build 1: API Lambda (auth, session management, prompt orchestration)
              'echo "Building API Lambda (private light)..."',
              'docker build --build-arg CMD_TARGET=media-lambda -t $PRIVATE_LIGHT_URI:api-$COMMIT -t $PRIVATE_LIGHT_URI:api-latest -f cmd/media-lambda/Dockerfile.light .',

              // --- ECR Public: Light images (generic, no ffmpeg) ---
              // Build 2: Enhancement Lambda (generic Gemini passthrough)
              'echo "Building Enhancement Lambda (public light)..."',
              'docker build --build-arg CMD_TARGET=enhance-lambda -t $PUBLIC_LIGHT_URI:enhance-$COMMIT -t $PUBLIC_LIGHT_URI:enhance-latest -f cmd/media-lambda/Dockerfile.light .',

              // --- ECR Public: Heavy images (generic, with ffmpeg) ---
              // Build 3: Thumbnail Lambda (generic ffmpeg thumbnail extraction)
              'echo "Building Thumbnail Lambda (public heavy)..."',
              'docker build --build-arg CMD_TARGET=thumbnail-lambda -t $PUBLIC_HEAVY_URI:thumb-$COMMIT -t $PUBLIC_HEAVY_URI:thumb-latest -f cmd/media-lambda/Dockerfile.heavy .',

              // --- ECR Private: Heavy images (proprietary, with ffmpeg) ---
              // Build 4: Selection Lambda (proprietary AI selection algorithms)
              'echo "Building Selection Lambda (private heavy)..."',
              'docker build --build-arg CMD_TARGET=selection-lambda -t $PRIVATE_HEAVY_URI:select-$COMMIT -t $PRIVATE_HEAVY_URI:select-latest -f cmd/media-lambda/Dockerfile.heavy .',

              // --- ECR Public: Heavy images (generic, with ffmpeg) ---
              // Build 5: Video Lambda (generic ffmpeg video processing)
              'echo "Building Video Lambda (public heavy)..."',
              'docker build --build-arg CMD_TARGET=video-lambda -t $PUBLIC_HEAVY_URI:video-$COMMIT -t $PUBLIC_HEAVY_URI:video-latest -f cmd/media-lambda/Dockerfile.heavy .',
            ],
          },
          post_build: {
            commands: [
              // Push ECR Private images
              'echo "Pushing private images..."',
              'docker push $PRIVATE_LIGHT_URI:api-$COMMIT',
              'docker push $PRIVATE_LIGHT_URI:api-latest',
              'docker push $PRIVATE_HEAVY_URI:select-$COMMIT',
              'docker push $PRIVATE_HEAVY_URI:select-latest',

              // Push ECR Public images
              'echo "Pushing public images..."',
              'docker push $PUBLIC_LIGHT_URI:enhance-$COMMIT',
              'docker push $PUBLIC_LIGHT_URI:enhance-latest',
              'docker push $PUBLIC_HEAVY_URI:thumb-$COMMIT',
              'docker push $PUBLIC_HEAVY_URI:thumb-latest',
              'docker push $PUBLIC_HEAVY_URI:video-$COMMIT',
              'docker push $PUBLIC_HEAVY_URI:video-latest',

              // Write image URIs for deploy stage
              `echo '{"apiImage":"'$PRIVATE_LIGHT_URI:api-$COMMIT'","enhanceImage":"'$PUBLIC_LIGHT_URI:enhance-$COMMIT'","thumbImage":"'$PUBLIC_HEAVY_URI:thumb-$COMMIT'","selectImage":"'$PRIVATE_HEAVY_URI:select-$COMMIT'","videoImage":"'$PUBLIC_HEAVY_URI:video-$COMMIT'"}' > imageDetail.json`,
            ],
          },
        },
        artifacts: {
          files: ['imageDetail.json'],
        },
      }),
    });

    // Grant CodeBuild permission to push images to ECR Private repos
    props.lightEcrRepo.grantPullPush(backendBuild);
    props.heavyEcrRepo.grantPullPush(backendBuild);

    // Grant ECR auth token permissions (private + public)
    backendBuild.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );

    // Grant ECR Public permissions (DDR-041)
    // ECR Public uses different IAM actions from ECR Private
    backendBuild.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr-public:GetAuthorizationToken',
          'ecr-public:BatchCheckLayerAvailability',
          'ecr-public:InitiateLayerUpload',
          'ecr-public:UploadLayerPart',
          'ecr-public:CompleteLayerUpload',
          'ecr-public:PutImage',
          'ecr-public:DescribeRegistries',
        ],
        resources: ['*'],
      }),
    );

    // ECR Public also requires sts:GetServiceBearerToken for auth
    backendBuild.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sts:GetServiceBearerToken'],
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

    // The deploy commands use variable env vars, so build them more explicitly.
    // Override the buildspec with cleaner commands.
    // Note: imageDetail.json contains URIs pointing to both ECR Private and ECR Public
    // repos (DDR-041). The deploy stage only reads these URIs — it doesn't need
    // Docker login since aws lambda update-function-code handles image pulling via IAM.
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

            `echo "Updating ${props.apiHandler.functionName} (private)..." && aws lambda update-function-code --function-name ${props.apiHandler.functionName} --image-uri $API_IMAGE`,
            `echo "Updating ${props.enhancementProcessor.functionName} (public)..." && aws lambda update-function-code --function-name ${props.enhancementProcessor.functionName} --image-uri $ENHANCE_IMAGE`,
            `echo "Updating ${props.thumbnailProcessor.functionName} (public)..." && aws lambda update-function-code --function-name ${props.thumbnailProcessor.functionName} --image-uri $THUMB_IMAGE`,
            `echo "Updating ${props.selectionProcessor.functionName} (private)..." && aws lambda update-function-code --function-name ${props.selectionProcessor.functionName} --image-uri $SELECT_IMAGE`,
            `echo "Updating ${props.videoProcessor.functionName} (public)..." && aws lambda update-function-code --function-name ${props.videoProcessor.functionName} --image-uri $VIDEO_IMAGE`,

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
