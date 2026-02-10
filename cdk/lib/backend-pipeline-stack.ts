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
      triggerOnPush: false, // Enable once pipeline is tested
    });

    // --- Backend Build (11 Docker images: 8 private + 3 public, DDR-053) ---
    // ECR Private repo URIs (account-specific)
    const privateLight = props.lightEcrRepo.repositoryUri;
    const privateHeavy = props.heavyEcrRepo.repositoryUri;
    const privateWebhook = props.webhookEcrRepo.repositoryUri;
    const privateOauth = props.oauthEcrRepo.repositoryUri;
    // ECR Public repo URIs (public.ecr.aws/<alias>/<repo-name>)
    // The public registry alias is resolved after the first push. We construct
    // the URI at build time using the AWS CLI to fetch the registry alias.
    const publicLightName = props.publicLightRepoName;
    const publicHeavyName = props.publicHeavyRepoName;

    const backendBuild = new codebuild.PipelineProject(this, 'BackendBuild', {
      projectName: 'AiSocialMediaBackendBuild',
      description: 'Build 11 Lambda Docker images (8 ECR Private + 3 ECR Public) with conditional rebuild detection',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.MEDIUM,
        privileged: true, // Required for Docker-in-Docker
      },
      // S3 cache for Go modules and build cache (DDR-047)
      cache: codebuild.Cache.bucket(artifactBucket, {
        prefix: 'codebuild-cache/backend',
      }),
      environmentVariables: {
        PRIVATE_LIGHT_URI: { value: privateLight },
        PRIVATE_HEAVY_URI: { value: privateHeavy },
        PRIVATE_WEBHOOK_URI: { value: privateWebhook },
        PRIVATE_OAUTH_URI: { value: privateOauth },
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
              // Enable Docker BuildKit for cache mounts and parallel stages (DDR-047)
              'export DOCKER_BUILDKIT=1',
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
              // Pull previous :latest images for Docker layer cache (DDR-047, soft-fail on first build)
              'echo "Pulling previous images for layer cache..."',
              'docker pull $PRIVATE_LIGHT_URI:api-latest || true',
              'docker pull $PRIVATE_HEAVY_URI:select-latest || true',
              'docker pull $PRIVATE_WEBHOOK_URI:webhook-latest || true',
              'docker pull $PRIVATE_OAUTH_URI:oauth-latest || true',
              // Go vulnerability scanning
              'go install golang.org/x/vuln/cmd/govulncheck@latest',
              'govulncheck ./... || echo "WARN: govulncheck found vulnerabilities (non-blocking)"',
            ],
          },
          build: {
            commands: [
              'COMMIT=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-7)',

              // --- Conditional build detection (DDR-047: skip unchanged images) ---
              // Fetch the last successful build commit from SSM
              'LAST_BUILD=$(aws ssm get-parameter --name /ai-social-media/last-build-commit --query "Parameter.Value" --output text 2>/dev/null || echo "")',
              'BUILD_ALL=true',
              // Per-Lambda flags (only used when shared code did NOT change, DDR-053)
              'BUILD_API=false; BUILD_TRIAGE=false; BUILD_DESC=false; BUILD_DOWNLOAD=false; BUILD_PUBLISH=false',
              'BUILD_ENHANCE=false; BUILD_WEBHOOK=false; BUILD_OAUTH=false',
              'BUILD_THUMB=false; BUILD_SELECT=false; BUILD_VIDEO=false',

              // Determine which images need rebuilding based on changed files
              'if [ -n "$LAST_BUILD" ] && git rev-parse "$LAST_BUILD" >/dev/null 2>&1; then '
                + 'CHANGED=$(git diff --name-only "$LAST_BUILD" HEAD); '
                + 'echo "=== Changed files since last build ($LAST_BUILD) ==="; echo "$CHANGED"; '
                + 'if echo "$CHANGED" | grep -qE "^(internal/|go\\.mod|go\\.sum|cmd/media-lambda/Dockerfile\\.)"; then '
                  + 'echo "Shared code or Dockerfile changed — rebuilding ALL images"; BUILD_ALL=true; '
                + 'else '
                  + 'BUILD_ALL=false; '
                  + 'echo "$CHANGED" | grep -q "^cmd/media-lambda/" && BUILD_API=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/triage-lambda/" && BUILD_TRIAGE=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/description-lambda/" && BUILD_DESC=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/download-lambda/" && BUILD_DOWNLOAD=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/publish-lambda/" && BUILD_PUBLISH=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/enhance-lambda/" && BUILD_ENHANCE=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/webhook-lambda/" && BUILD_WEBHOOK=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/oauth-lambda/" && BUILD_OAUTH=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/thumbnail-lambda/" && BUILD_THUMB=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/selection-lambda/" && BUILD_SELECT=true; '
                  + 'echo "$CHANGED" | grep -q "^cmd/video-lambda/" && BUILD_VIDEO=true; '
                  + 'echo "Selective build: API=$BUILD_API TRIAGE=$BUILD_TRIAGE DESC=$BUILD_DESC DOWNLOAD=$BUILD_DOWNLOAD PUBLISH=$BUILD_PUBLISH ENHANCE=$BUILD_ENHANCE WEBHOOK=$BUILD_WEBHOOK OAUTH=$BUILD_OAUTH THUMB=$BUILD_THUMB SELECT=$BUILD_SELECT VIDEO=$BUILD_VIDEO"; '
                + 'fi; '
              + 'else echo "No previous build commit found — rebuilding ALL images"; fi',

              // --- Parallel Docker builds in 3 waves (DDR-047) ---
              // Helper function for building images with --cache-from
              // --provenance=false: required for Lambda-compatible Docker image manifest (avoids OCI index)
              'build_image() { local cmd=$1 df=$2 tags=$3 cache=$4; echo "Building $cmd..."; docker build --provenance=false --cache-from "$cache" --build-arg CMD_TARGET="$cmd" -f "cmd/media-lambda/$df" $tags . 2>&1 | tee "/tmp/build-$cmd.log"; }',

              // Wave 1: Light images (fast, ~30s each, no ffmpeg, DDR-053)
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_API" = "true" ]) && touch /tmp/built-api && build_image media-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:api-$COMMIT -t $PRIVATE_LIGHT_URI:api-latest" "$PRIVATE_LIGHT_URI:api-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_TRIAGE" = "true" ]) && touch /tmp/built-triage && build_image triage-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:triage-$COMMIT -t $PRIVATE_LIGHT_URI:triage-latest" "$PRIVATE_LIGHT_URI:api-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_DESC" = "true" ]) && touch /tmp/built-desc && build_image description-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:desc-$COMMIT -t $PRIVATE_LIGHT_URI:desc-latest" "$PRIVATE_LIGHT_URI:api-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_DOWNLOAD" = "true" ]) && touch /tmp/built-download && build_image download-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:download-$COMMIT -t $PRIVATE_LIGHT_URI:download-latest" "$PRIVATE_LIGHT_URI:api-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_PUBLISH" = "true" ]) && touch /tmp/built-publish && build_image publish-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:publish-$COMMIT -t $PRIVATE_LIGHT_URI:publish-latest" "$PRIVATE_LIGHT_URI:api-latest" &',
              'wait',

              // Wave 2: More light images (DDR-053: split wave to avoid too many concurrent builds)
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_ENHANCE" = "true" ]) && touch /tmp/built-enhance && build_image enhance-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:enhance-$COMMIT -t $PRIVATE_LIGHT_URI:enhance-latest -t $PUBLIC_LIGHT_URI:enhance-$COMMIT -t $PUBLIC_LIGHT_URI:enhance-latest" "$PRIVATE_LIGHT_URI:api-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_WEBHOOK" = "true" ]) && touch /tmp/built-webhook && build_image webhook-lambda Dockerfile.light "-t $PRIVATE_WEBHOOK_URI:webhook-$COMMIT -t $PRIVATE_WEBHOOK_URI:webhook-latest" "$PRIVATE_WEBHOOK_URI:webhook-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_OAUTH" = "true" ]) && touch /tmp/built-oauth && build_image oauth-lambda Dockerfile.light "-t $PRIVATE_OAUTH_URI:oauth-$COMMIT -t $PRIVATE_OAUTH_URI:oauth-latest" "$PRIVATE_OAUTH_URI:oauth-latest" &',
              'wait',

              // Wave 3: Heavy images (slower, ~60-90s each, includes ffmpeg)
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_THUMB" = "true" ]) && touch /tmp/built-thumb && build_image thumbnail-lambda Dockerfile.heavy "-t $PRIVATE_HEAVY_URI:thumb-$COMMIT -t $PRIVATE_HEAVY_URI:thumb-latest -t $PUBLIC_HEAVY_URI:thumb-$COMMIT -t $PUBLIC_HEAVY_URI:thumb-latest" "$PRIVATE_HEAVY_URI:select-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_SELECT" = "true" ]) && touch /tmp/built-select && build_image selection-lambda Dockerfile.heavy "-t $PRIVATE_HEAVY_URI:select-$COMMIT -t $PRIVATE_HEAVY_URI:select-latest" "$PRIVATE_HEAVY_URI:select-latest" &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_VIDEO" = "true" ]) && touch /tmp/built-video && build_image video-lambda Dockerfile.heavy "-t $PRIVATE_HEAVY_URI:video-$COMMIT -t $PRIVATE_HEAVY_URI:video-latest -t $PUBLIC_HEAVY_URI:video-$COMMIT -t $PUBLIC_HEAVY_URI:video-latest" "$PRIVATE_HEAVY_URI:select-latest" &',
              'wait',

              // Log build summary
              'echo "=== Build summary ==="; for img in api triage desc download publish enhance webhook oauth thumb select video; do [ -f /tmp/built-$img ] && echo "  $img: BUILT" || echo "  $img: SKIPPED (unchanged)"; done',
            ],
          },
          post_build: {
            commands: [
              // Push only images that were built (DDR-047: conditional builds)
              'echo "Pushing built images in parallel..."',
              // ECR Private: light images (only if built, DDR-053)
              '[ -f /tmp/built-api ] && docker push $PRIVATE_LIGHT_URI:api-$COMMIT &',
              '[ -f /tmp/built-api ] && docker push $PRIVATE_LIGHT_URI:api-latest &',
              '[ -f /tmp/built-triage ] && docker push $PRIVATE_LIGHT_URI:triage-$COMMIT &',
              '[ -f /tmp/built-triage ] && docker push $PRIVATE_LIGHT_URI:triage-latest &',
              '[ -f /tmp/built-desc ] && docker push $PRIVATE_LIGHT_URI:desc-$COMMIT &',
              '[ -f /tmp/built-desc ] && docker push $PRIVATE_LIGHT_URI:desc-latest &',
              '[ -f /tmp/built-download ] && docker push $PRIVATE_LIGHT_URI:download-$COMMIT &',
              '[ -f /tmp/built-download ] && docker push $PRIVATE_LIGHT_URI:download-latest &',
              '[ -f /tmp/built-publish ] && docker push $PRIVATE_LIGHT_URI:publish-$COMMIT &',
              '[ -f /tmp/built-publish ] && docker push $PRIVATE_LIGHT_URI:publish-latest &',
              '[ -f /tmp/built-enhance ] && docker push $PRIVATE_LIGHT_URI:enhance-$COMMIT &',
              '[ -f /tmp/built-enhance ] && docker push $PRIVATE_LIGHT_URI:enhance-latest &',
              // ECR Private: heavy images (only if built)
              '[ -f /tmp/built-select ] && docker push $PRIVATE_HEAVY_URI:select-$COMMIT &',
              '[ -f /tmp/built-select ] && docker push $PRIVATE_HEAVY_URI:select-latest &',
              '[ -f /tmp/built-thumb ] && docker push $PRIVATE_HEAVY_URI:thumb-$COMMIT &',
              '[ -f /tmp/built-thumb ] && docker push $PRIVATE_HEAVY_URI:thumb-latest &',
              '[ -f /tmp/built-video ] && docker push $PRIVATE_HEAVY_URI:video-$COMMIT &',
              '[ -f /tmp/built-video ] && docker push $PRIVATE_HEAVY_URI:video-latest &',
              // ECR Private: webhook (only if built, DDR-044)
              '[ -f /tmp/built-webhook ] && docker push $PRIVATE_WEBHOOK_URI:webhook-$COMMIT &',
              '[ -f /tmp/built-webhook ] && docker push $PRIVATE_WEBHOOK_URI:webhook-latest &',
              // ECR Private: oauth (only if built, DDR-048)
              '[ -f /tmp/built-oauth ] && docker push $PRIVATE_OAUTH_URI:oauth-$COMMIT &',
              '[ -f /tmp/built-oauth ] && docker push $PRIVATE_OAUTH_URI:oauth-latest &',
              // ECR Public images (only if built, DDR-041)
              '[ -f /tmp/built-enhance ] && docker push $PUBLIC_LIGHT_URI:enhance-$COMMIT &',
              '[ -f /tmp/built-enhance ] && docker push $PUBLIC_LIGHT_URI:enhance-latest &',
              '[ -f /tmp/built-thumb ] && docker push $PUBLIC_HEAVY_URI:thumb-$COMMIT &',
              '[ -f /tmp/built-thumb ] && docker push $PUBLIC_HEAVY_URI:thumb-latest &',
              '[ -f /tmp/built-video ] && docker push $PUBLIC_HEAVY_URI:video-$COMMIT &',
              '[ -f /tmp/built-video ] && docker push $PUBLIC_HEAVY_URI:video-latest &',
              'wait',

              // Write image URIs for deploy stage — use new tag if built, :latest if skipped (DDR-053)
              'API_TAG=$([ -f /tmp/built-api ] && echo "api-$COMMIT" || echo "api-latest")',
              'TRIAGE_TAG=$([ -f /tmp/built-triage ] && echo "triage-$COMMIT" || echo "triage-latest")',
              'DESC_TAG=$([ -f /tmp/built-desc ] && echo "desc-$COMMIT" || echo "desc-latest")',
              'DOWNLOAD_TAG=$([ -f /tmp/built-download ] && echo "download-$COMMIT" || echo "download-latest")',
              'PUBLISH_TAG=$([ -f /tmp/built-publish ] && echo "publish-$COMMIT" || echo "publish-latest")',
              'ENHANCE_TAG=$([ -f /tmp/built-enhance ] && echo "enhance-$COMMIT" || echo "enhance-latest")',
              'THUMB_TAG=$([ -f /tmp/built-thumb ] && echo "thumb-$COMMIT" || echo "thumb-latest")',
              'SELECT_TAG=$([ -f /tmp/built-select ] && echo "select-$COMMIT" || echo "select-latest")',
              'VIDEO_TAG=$([ -f /tmp/built-video ] && echo "video-$COMMIT" || echo "video-latest")',
              'WEBHOOK_TAG=$([ -f /tmp/built-webhook ] && echo "webhook-$COMMIT" || echo "webhook-latest")',
              'OAUTH_TAG=$([ -f /tmp/built-oauth ] && echo "oauth-$COMMIT" || echo "oauth-latest")',
              `echo '{"apiImage":"'$PRIVATE_LIGHT_URI:$API_TAG'","triageImage":"'$PRIVATE_LIGHT_URI:$TRIAGE_TAG'","descImage":"'$PRIVATE_LIGHT_URI:$DESC_TAG'","downloadImage":"'$PRIVATE_LIGHT_URI:$DOWNLOAD_TAG'","publishImage":"'$PRIVATE_LIGHT_URI:$PUBLISH_TAG'","enhanceImage":"'$PRIVATE_LIGHT_URI:$ENHANCE_TAG'","thumbImage":"'$PRIVATE_HEAVY_URI:$THUMB_TAG'","selectImage":"'$PRIVATE_HEAVY_URI:$SELECT_TAG'","videoImage":"'$PRIVATE_HEAVY_URI:$VIDEO_TAG'","webhookImage":"'$PRIVATE_WEBHOOK_URI:$WEBHOOK_TAG'","oauthImage":"'$PRIVATE_OAUTH_URI:$OAUTH_TAG'"}' > imageDetail.json`,
            ],
          },
        },
        artifacts: {
          files: ['imageDetail.json'],
        },
        cache: {
          paths: [
            '/go/pkg/mod/**/*',
            '/root/.cache/go-build/**/*',
          ],
        },
      }),
    });

    // Grant CodeBuild permission to push images to ECR Private repos
    props.lightEcrRepo.grantPullPush(backendBuild);
    props.heavyEcrRepo.grantPullPush(backendBuild);
    props.webhookEcrRepo.grantPullPush(backendBuild);
    props.oauthEcrRepo.grantPullPush(backendBuild);

    // Grant read access to the ffmpeg cache repo (ECR-mirrored mwader/static-ffmpeg)
    backendBuild.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchCheckLayerAvailability',
        ],
        resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/static-ffmpeg-cache`],
      }),
    );

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

    // SSM read permission for conditional builds — fetch last build commit (DDR-047)
    backendBuild.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/last-build-commit`],
      }),
    );

    // --- Deploy (update all Lambda functions, DDR-053) ---
    const allLambdas = [
      { name: props.apiHandler.functionName, imageKey: 'apiImage' },
      { name: props.triageProcessor.functionName, imageKey: 'triageImage' },
      { name: props.descriptionProcessor.functionName, imageKey: 'descImage' },
      { name: props.downloadProcessor.functionName, imageKey: 'downloadImage' },
      { name: props.publishProcessor.functionName, imageKey: 'publishImage' },
      { name: props.enhancementProcessor.functionName, imageKey: 'enhanceImage' },
      { name: props.thumbnailProcessor.functionName, imageKey: 'thumbImage' },
      { name: props.selectionProcessor.functionName, imageKey: 'selectImage' },
      { name: props.videoProcessor.functionName, imageKey: 'videoImage' },
      { name: props.webhookHandler.functionName, imageKey: 'webhookImage' },
      { name: props.oauthHandler.functionName, imageKey: 'oauthImage' },
    ];

    const deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: 'AiSocialMediaBackendDeploy',
      description: 'Deploy built Docker images to all 11 Lambda functions and wait for update completion',
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
            // Parse image URIs from build output (DDR-053: 11 images)
            'export API_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'apiImage\'])")',
            'export TRIAGE_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'triageImage\'])")',
            'export DESC_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'descImage\'])")',
            'export DOWNLOAD_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'downloadImage\'])")',
            'export PUBLISH_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'publishImage\'])")',
            'export ENHANCE_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'enhanceImage\'])")',
            'export THUMB_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'thumbImage\'])")',
            'export SELECT_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'selectImage\'])")',
            'export VIDEO_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'videoImage\'])")',
            'export WEBHOOK_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'webhookImage\'])")',
            'export OAUTH_IMAGE=$(python3 -c "import json; print(json.load(open(\'imageDetail.json\'))[\'oauthImage\'])")',

            // Update each Lambda with its specific image
            `echo "Updating ${props.apiHandler.functionName} (private)..." && aws lambda update-function-code --function-name ${props.apiHandler.functionName} --image-uri $API_IMAGE`,
            `echo "Updating ${props.triageProcessor.functionName} (private triage)..." && aws lambda update-function-code --function-name ${props.triageProcessor.functionName} --image-uri $TRIAGE_IMAGE`,
            `echo "Updating ${props.descriptionProcessor.functionName} (private desc)..." && aws lambda update-function-code --function-name ${props.descriptionProcessor.functionName} --image-uri $DESC_IMAGE`,
            `echo "Updating ${props.downloadProcessor.functionName} (private download)..." && aws lambda update-function-code --function-name ${props.downloadProcessor.functionName} --image-uri $DOWNLOAD_IMAGE`,
            `echo "Updating ${props.publishProcessor.functionName} (private publish)..." && aws lambda update-function-code --function-name ${props.publishProcessor.functionName} --image-uri $PUBLISH_IMAGE`,
            `echo "Updating ${props.enhancementProcessor.functionName} (public)..." && aws lambda update-function-code --function-name ${props.enhancementProcessor.functionName} --image-uri $ENHANCE_IMAGE`,
            `echo "Updating ${props.thumbnailProcessor.functionName} (public)..." && aws lambda update-function-code --function-name ${props.thumbnailProcessor.functionName} --image-uri $THUMB_IMAGE`,
            `echo "Updating ${props.selectionProcessor.functionName} (private)..." && aws lambda update-function-code --function-name ${props.selectionProcessor.functionName} --image-uri $SELECT_IMAGE`,
            `echo "Updating ${props.videoProcessor.functionName} (public)..." && aws lambda update-function-code --function-name ${props.videoProcessor.functionName} --image-uri $VIDEO_IMAGE`,
            `echo "Updating ${props.webhookHandler.functionName} (private webhook)..." && aws lambda update-function-code --function-name ${props.webhookHandler.functionName} --image-uri $WEBHOOK_IMAGE`,
            `echo "Updating ${props.oauthHandler.functionName} (private oauth)..." && aws lambda update-function-code --function-name ${props.oauthHandler.functionName} --image-uri $OAUTH_IMAGE`,

            // Wait for all function updates to complete
            `aws lambda wait function-updated --function-name ${props.apiHandler.functionName}`,
            `aws lambda wait function-updated --function-name ${props.triageProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.descriptionProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.downloadProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.publishProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.enhancementProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.thumbnailProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.selectionProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.videoProcessor.functionName}`,
            `aws lambda wait function-updated --function-name ${props.webhookHandler.functionName}`,
            `aws lambda wait function-updated --function-name ${props.oauthHandler.functionName}`,

            // Save successful build commit to SSM for conditional builds (DDR-047)
            'export FULL_COMMIT=$(python3 -c "import json; d=json.load(open(\'imageDetail.json\')); uri=d[\'apiImage\']; print(uri.split(\':\')[-1].split(\'-\')[-1])" 2>/dev/null || echo "")',
            'aws ssm put-parameter --name /ai-social-media/last-build-commit --value "$CODEBUILD_RESOLVED_SOURCE_VERSION" --type String --overwrite',
          ],
        },
      },
    }));

    // Grant deploy project permissions for all Lambda updates (DDR-053)
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
        resources: [
          props.apiHandler.functionArn,
          props.triageProcessor.functionArn,
          props.descriptionProcessor.functionArn,
          props.downloadProcessor.functionArn,
          props.publishProcessor.functionArn,
          props.thumbnailProcessor.functionArn,
          props.selectionProcessor.functionArn,
          props.enhancementProcessor.functionArn,
          props.videoProcessor.functionArn,
          props.webhookHandler.functionArn,
          props.oauthHandler.functionArn,
        ],
      }),
    );

    // SSM write permission for conditional builds — save last build commit (DDR-047)
    deployProject.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/last-build-commit`],
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

    // Artifact bucket output moved to StorageStack (DDR-045)
  }
}
