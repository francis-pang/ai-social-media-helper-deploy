import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BackendBuildProjectProps {
  /** ECR Private light repository */
  lightEcrRepo: ecr.IRepository;
  /** ECR Private heavy repository */
  heavyEcrRepo: ecr.IRepository;
  /** ECR Private webhook repository */
  webhookEcrRepo: ecr.IRepository;
  /** ECR Private OAuth repository */
  oauthEcrRepo: ecr.IRepository;
  /** ECR Public light repository name */
  publicLightRepoName: string;
  /** ECR Public heavy repository name */
  publicHeavyRepoName: string;
  /** S3 bucket for CodeBuild cache */
  artifactBucket: s3.IBucket;
  /** AWS account ID */
  account: string;
  /** AWS region */
  region: string;
}

/**
 * Creates the CodeBuild project for the backend build stage (11 Docker images).
 * Includes buildspec, ECR grants, and environment variables.
 */
export function createBackendBuildProject(
  scope: Construct,
  id: string,
  props: BackendBuildProjectProps,
): codebuild.PipelineProject {
  const privateLight = props.lightEcrRepo.repositoryUri;
  const privateHeavy = props.heavyEcrRepo.repositoryUri;
  const privateWebhook = props.webhookEcrRepo.repositoryUri;
  const privateOauth = props.oauthEcrRepo.repositoryUri;

  const project = new codebuild.PipelineProject(scope, id, {
    projectName: 'AiSocialMediaBackendBuild',
    description: 'Build 11 Lambda Docker images (8 ECR Private + 3 ECR Public) with conditional rebuild detection',
    environment: {
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
      computeType: codebuild.ComputeType.MEDIUM,
      privileged: true, // Required for Docker-in-Docker
    },
    cache: codebuild.Cache.local(codebuild.LocalCacheMode.DOCKER_LAYER, codebuild.LocalCacheMode.CUSTOM),
    environmentVariables: {
      PRIVATE_LIGHT_URI: { value: privateLight },
      PRIVATE_HEAVY_URI: { value: privateHeavy },
      PRIVATE_WEBHOOK_URI: { value: privateWebhook },
      PRIVATE_OAUTH_URI: { value: privateOauth },
      PUBLIC_LIGHT_NAME: { value: props.publicLightRepoName },
      PUBLIC_HEAVY_NAME: { value: props.publicHeavyRepoName },
      AWS_ACCOUNT_ID: { value: props.account },
      AWS_REGION_NAME: { value: props.region },
    },
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        install: {
          commands: [
            // Go 1.26 is not yet in CodeBuild AL2023 ARM standard images; install manually.
            'curl -sL https://go.dev/dl/go1.26.0.linux-arm64.tar.gz -o /tmp/go.tar.gz',
            'rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tar.gz && rm /tmp/go.tar.gz',
            'export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH',
            'go version',
          ],
        },
        pre_build: {
          commands: [
            'export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH',
            'export DOCKER_BUILDKIT=1',
            'aws ecr get-login-password --region $AWS_REGION_NAME | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION_NAME.amazonaws.com',
            'aws ecr-public get-login-password --region us-east-1 | docker login --username AWS --password-stdin public.ecr.aws',
            'export PUBLIC_ALIAS=$(aws ecr-public describe-registries --region us-east-1 --query "registries[0].aliases[0].name" --output text)',
            'export PUBLIC_LIGHT_URI=public.ecr.aws/$PUBLIC_ALIAS/$PUBLIC_LIGHT_NAME',
            'export PUBLIC_HEAVY_URI=public.ecr.aws/$PUBLIC_ALIAS/$PUBLIC_HEAVY_NAME',
            'echo "ECR Public alias: $PUBLIC_ALIAS"',
            'echo "Public light URI: $PUBLIC_LIGHT_URI"',
            'echo "Public heavy URI: $PUBLIC_HEAVY_URI"',
            'echo "Pulling previous images for layer cache..."',
            'docker pull $PRIVATE_LIGHT_URI:api-latest || true',
            'docker pull $PRIVATE_HEAVY_URI:select-latest || true',
            'docker pull $PRIVATE_WEBHOOK_URI:webhook-latest || true',
            'docker pull $PRIVATE_OAUTH_URI:oauth-latest || true',
            'go install golang.org/x/vuln/cmd/govulncheck@latest',
            'govulncheck ./...', // Risk 28: Blocking — fails the build if known vulnerabilities are found
          ],
        },
        build: {
          commands: [
            // IMPORTANT: All variable assignments use `export` because CodeBuild runs
            // each command entry in a separate shell. Exported env vars persist across entries.
            'export COMMIT=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c1-7)',
            'export LAST_BUILD=$(aws ssm get-parameter --name /ai-social-media/last-build-commit --query "Parameter.Value" --output text 2>/dev/null || echo "")',
            'export BUILD_ALL=true',
            'export BUILD_API=false; export BUILD_TRIAGE=false; export BUILD_DESC=false; export BUILD_DOWNLOAD=false; export BUILD_PUBLISH=false',
            'export BUILD_ENHANCE=false; export BUILD_WEBHOOK=false; export BUILD_OAUTH=false',
            'export BUILD_THUMB=false; export BUILD_SELECT=false; export BUILD_VIDEO=false; export BUILD_MEDIAPROCESS=false',
            'if [ -n "$LAST_BUILD" ] && git rev-parse "$LAST_BUILD" >/dev/null 2>&1; then '
              + 'CHANGED=$(git diff --name-only "$LAST_BUILD" HEAD); '
              + 'echo "=== Changed files since last build ($LAST_BUILD) ==="; echo "$CHANGED"; '
              + 'if echo "$CHANGED" | grep -qE "^(internal/|go\\.mod|go\\.sum|cmd/media-lambda/Dockerfile\\.)"; then '
                + 'echo "Shared code or Dockerfile changed — rebuilding ALL images"; export BUILD_ALL=true; '
              + 'else '
                + 'export BUILD_ALL=false; '
                + 'echo "$CHANGED" | grep -q "^cmd/media-lambda/" && export BUILD_API=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/triage-lambda/" && export BUILD_TRIAGE=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/description-lambda/" && export BUILD_DESC=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/download-lambda/" && export BUILD_DOWNLOAD=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/publish-lambda/" && export BUILD_PUBLISH=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/enhance-lambda/" && export BUILD_ENHANCE=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/webhook-lambda/" && export BUILD_WEBHOOK=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/oauth-lambda/" && export BUILD_OAUTH=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/thumbnail-lambda/" && export BUILD_THUMB=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/selection-lambda/" && export BUILD_SELECT=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/video-lambda/" && export BUILD_VIDEO=true; '
                + 'echo "$CHANGED" | grep -q "^cmd/media-process-lambda/" && export BUILD_MEDIAPROCESS=true; '
                + 'echo "Selective build: API=$BUILD_API TRIAGE=$BUILD_TRIAGE DESC=$BUILD_DESC DOWNLOAD=$BUILD_DOWNLOAD PUBLISH=$BUILD_PUBLISH ENHANCE=$BUILD_ENHANCE WEBHOOK=$BUILD_WEBHOOK OAUTH=$BUILD_OAUTH THUMB=$BUILD_THUMB SELECT=$BUILD_SELECT VIDEO=$BUILD_VIDEO MEDIAPROCESS=$BUILD_MEDIAPROCESS"; '
              + 'fi; '
            + 'else echo "No previous build commit found — rebuilding ALL images"; fi',
            // Diagnostic dump: log all build-decision variables so failures are diagnosable
            // from CloudWatch alone, without guessing.
            'echo "=== Build decision vars ==="; echo "COMMIT=$COMMIT LAST_BUILD=$LAST_BUILD BUILD_ALL=$BUILD_ALL"; echo "BUILD_API=$BUILD_API BUILD_TRIAGE=$BUILD_TRIAGE BUILD_DESC=$BUILD_DESC BUILD_DOWNLOAD=$BUILD_DOWNLOAD BUILD_PUBLISH=$BUILD_PUBLISH"; echo "BUILD_ENHANCE=$BUILD_ENHANCE BUILD_WEBHOOK=$BUILD_WEBHOOK BUILD_OAUTH=$BUILD_OAUTH BUILD_THUMB=$BUILD_THUMB BUILD_SELECT=$BUILD_SELECT BUILD_VIDEO=$BUILD_VIDEO BUILD_MEDIAPROCESS=$BUILD_MEDIAPROCESS"; echo "PRIVATE_LIGHT_URI=$PRIVATE_LIGHT_URI PRIVATE_HEAVY_URI=$PRIVATE_HEAVY_URI"; echo "PRIVATE_WEBHOOK_URI=$PRIVATE_WEBHOOK_URI PRIVATE_OAUTH_URI=$PRIVATE_OAUTH_URI"; echo "PWD=$(pwd)"; ls -la cmd/media-lambda/Dockerfile.* 2>&1; echo "=== End vars ==="',
            // DDR-062: Pass COMMIT_HASH build arg to all images for version identity.
            //
            // PARALLEL BUILD STRATEGY — heredoc + bash:
            // CodeBuild does NOT block on `wait` inside multi-line command entries (tested:
            // both '; ' join and '\n' join fail — background processes are orphaned when
            // CodeBuild moves to the next command entry). The fix: write each wave's script
            // to a temp file via heredoc, then execute with `bash` as a SEPARATE command
            // entry. The `bash` command is a simple single-line entry that CodeBuild blocks
            // on, and `wait` inside the script works correctly because all background
            // processes are children of that bash process.
            //
            // The heredoc uses a single-quoted delimiter (<<'END') to prevent variable
            // expansion in the heredoc itself — variables expand at runtime when bash
            // executes the script, reading exported env vars from earlier command entries.

            // Wave 1: Light images (api, triage, desc, download, publish)
            [
              "cat > /tmp/wave1.sh <<'ENDWAVE1'",
              'set -uo pipefail',
              'echo ">>> Wave 1 start: $(date -u +%H:%M:%S) | BUILD_ALL=$BUILD_ALL"',
              'build_image() {',
              '  set -o pipefail; local cmd=$1 df=$2 tags=$3 cache=$4 extra_args="${5:-}"',
              '  echo ">>> [$cmd] START $(date -u +%H:%M:%S) — dockerfile=cmd/media-lambda/$df"',
              '  echo ">>> [$cmd] tags: $tags"',
              '  echo ">>> [$cmd] cache-from: $cache"',
              '  local start_ts=$(date +%s)',
              '  docker build --provenance=false --progress=plain --cache-from "$cache" --build-arg CMD_TARGET="$cmd" --build-arg COMMIT_HASH="$COMMIT" $extra_args -f "cmd/media-lambda/$df" $tags . 2>&1 | tee "/tmp/build-$cmd.log"',
              '  local rc=$?; local elapsed=$(( $(date +%s) - start_ts ))',
              '  echo ">>> [$cmd] DONE rc=$rc elapsed=${elapsed}s $(date -u +%H:%M:%S)"',
              '  return $rc',
              '}',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_API" = "true" ]) && (build_image media-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:api-$COMMIT -t $PRIVATE_LIGHT_URI:api-latest" "$PRIVATE_LIGHT_URI:api-latest" && touch /tmp/built-api) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_TRIAGE" = "true" ]) && (build_image triage-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:triage-$COMMIT -t $PRIVATE_LIGHT_URI:triage-latest" "$PRIVATE_LIGHT_URI:api-latest" && touch /tmp/built-triage) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_DESC" = "true" ]) && (build_image description-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:desc-$COMMIT -t $PRIVATE_LIGHT_URI:desc-latest" "$PRIVATE_LIGHT_URI:api-latest" && touch /tmp/built-desc) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_DOWNLOAD" = "true" ]) && (build_image download-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:download-$COMMIT -t $PRIVATE_LIGHT_URI:download-latest" "$PRIVATE_LIGHT_URI:api-latest" && touch /tmp/built-download) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_PUBLISH" = "true" ]) && (build_image publish-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:publish-$COMMIT -t $PRIVATE_LIGHT_URI:publish-latest" "$PRIVATE_LIGHT_URI:api-latest" && touch /tmp/built-publish) &',
              'wait; echo ">>> Wave 1 done: $(date -u +%H:%M:%S)"',
              'ENDWAVE1',
            ].join('\n'),
            'echo "--- wave1.sh ---"; cat /tmp/wave1.sh; echo "--- end ---"; bash /tmp/wave1.sh',
            // Wave 2: Light images (enhance, webhook, oauth) — same build_image + tracing
            [
              "cat > /tmp/wave2.sh <<'ENDWAVE2'",
              'set -uo pipefail',
              'echo ">>> Wave 2 start: $(date -u +%H:%M:%S) | BUILD_ALL=$BUILD_ALL"',
              'build_image() {',
              '  set -o pipefail; local cmd=$1 df=$2 tags=$3 cache=$4 extra_args="${5:-}"',
              '  echo ">>> [$cmd] START $(date -u +%H:%M:%S) — dockerfile=cmd/media-lambda/$df"',
              '  echo ">>> [$cmd] tags: $tags"',
              '  local start_ts=$(date +%s)',
              '  docker build --provenance=false --progress=plain --cache-from "$cache" --build-arg CMD_TARGET="$cmd" --build-arg COMMIT_HASH="$COMMIT" $extra_args -f "cmd/media-lambda/$df" $tags . 2>&1 | tee "/tmp/build-$cmd.log"',
              '  local rc=$?; local elapsed=$(( $(date +%s) - start_ts ))',
              '  echo ">>> [$cmd] DONE rc=$rc elapsed=${elapsed}s $(date -u +%H:%M:%S)"',
              '  return $rc',
              '}',
              // Risk 37: App-specific images only go to private repos. Public repos reserved for generic base images.
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_ENHANCE" = "true" ]) && (build_image enhance-lambda Dockerfile.light "-t $PRIVATE_LIGHT_URI:enhance-$COMMIT -t $PRIVATE_LIGHT_URI:enhance-latest" "$PRIVATE_LIGHT_URI:api-latest" && touch /tmp/built-enhance) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_WEBHOOK" = "true" ]) && (build_image webhook-lambda Dockerfile.light "-t $PRIVATE_WEBHOOK_URI:webhook-$COMMIT -t $PRIVATE_WEBHOOK_URI:webhook-latest" "$PRIVATE_WEBHOOK_URI:webhook-latest" && touch /tmp/built-webhook) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_OAUTH" = "true" ]) && (build_image oauth-lambda Dockerfile.light "-t $PRIVATE_OAUTH_URI:oauth-$COMMIT -t $PRIVATE_OAUTH_URI:oauth-latest" "$PRIVATE_OAUTH_URI:oauth-latest" && touch /tmp/built-oauth) &',
              'wait; echo ">>> Wave 2 done: $(date -u +%H:%M:%S)"',
              'ENDWAVE2',
            ].join('\n'),
            'echo "--- wave2.sh ---"; cat /tmp/wave2.sh; echo "--- end ---"; bash /tmp/wave2.sh',
            // Wave 3: Heavy images (thumb, select, video, mediaprocess) — same build_image + tracing
            [
              "cat > /tmp/wave3.sh <<'ENDWAVE3'",
              'set -uo pipefail',
              'echo ">>> Wave 3 start: $(date -u +%H:%M:%S) | BUILD_ALL=$BUILD_ALL"',
              'build_image() {',
              '  set -o pipefail; local cmd=$1 df=$2 tags=$3 cache=$4 extra_args="${5:-}"',
              '  echo ">>> [$cmd] START $(date -u +%H:%M:%S) — dockerfile=cmd/media-lambda/$df"',
              '  echo ">>> [$cmd] tags: $tags"',
              '  local start_ts=$(date +%s)',
              '  docker build --provenance=false --progress=plain --cache-from "$cache" --build-arg CMD_TARGET="$cmd" --build-arg COMMIT_HASH="$COMMIT" $extra_args -f "cmd/media-lambda/$df" $tags . 2>&1 | tee "/tmp/build-$cmd.log"',
              '  local rc=$?; local elapsed=$(( $(date +%s) - start_ts ))',
              '  echo ">>> [$cmd] DONE rc=$rc elapsed=${elapsed}s $(date -u +%H:%M:%S)"',
              '  return $rc',
              '}',
              // Risk 37: App-specific images only go to private repos.
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_THUMB" = "true" ]) && (build_image thumbnail-lambda Dockerfile.heavy "-t $PRIVATE_HEAVY_URI:thumb-$COMMIT -t $PRIVATE_HEAVY_URI:thumb-latest" "$PRIVATE_HEAVY_URI:select-latest" "--build-arg ECR_ACCOUNT_ID=$AWS_ACCOUNT_ID" && touch /tmp/built-thumb) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_SELECT" = "true" ]) && (build_image selection-lambda Dockerfile.heavy "-t $PRIVATE_HEAVY_URI:select-$COMMIT -t $PRIVATE_HEAVY_URI:select-latest" "$PRIVATE_HEAVY_URI:select-latest" "--build-arg ECR_ACCOUNT_ID=$AWS_ACCOUNT_ID" && touch /tmp/built-select) &',
              // Risk 37: App-specific images only go to private repos.
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_VIDEO" = "true" ]) && (build_image video-lambda Dockerfile.heavy "-t $PRIVATE_HEAVY_URI:video-$COMMIT -t $PRIVATE_HEAVY_URI:video-latest" "$PRIVATE_HEAVY_URI:select-latest" "--build-arg ECR_ACCOUNT_ID=$AWS_ACCOUNT_ID" && touch /tmp/built-video) &',
              '([ "$BUILD_ALL" = "true" ] || [ "$BUILD_MEDIAPROCESS" = "true" ]) && (build_image media-process-lambda Dockerfile.heavy "-t $PRIVATE_HEAVY_URI:mediaprocess-$COMMIT -t $PRIVATE_HEAVY_URI:mediaprocess-latest" "$PRIVATE_HEAVY_URI:select-latest" "--build-arg ECR_ACCOUNT_ID=$AWS_ACCOUNT_ID" && touch /tmp/built-mediaprocess) &',
              'wait; echo ">>> Wave 3 done: $(date -u +%H:%M:%S)"',
              'ENDWAVE3',
            ].join('\n'),
            'echo "--- wave3.sh ---"; cat /tmp/wave3.sh; echo "--- end ---"; bash /tmp/wave3.sh',
            'echo "=== Build summary ==="; for img in api triage desc download publish enhance webhook oauth thumb select video mediaprocess; do [ -f /tmp/built-$img ] && echo "  $img: BUILT" || echo "  $img: SKIPPED (unchanged)"; done',
          ],
        },
        post_build: {
          commands: [
            // Push all built images in parallel — heredoc + bash (same pattern as build waves).
            [
              "cat > /tmp/push.sh <<'ENDPUSH'",
              'echo "Pushing built images in parallel..."',
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
              '[ -f /tmp/built-select ] && docker push $PRIVATE_HEAVY_URI:select-$COMMIT &',
              '[ -f /tmp/built-select ] && docker push $PRIVATE_HEAVY_URI:select-latest &',
              '[ -f /tmp/built-thumb ] && docker push $PRIVATE_HEAVY_URI:thumb-$COMMIT &',
              '[ -f /tmp/built-thumb ] && docker push $PRIVATE_HEAVY_URI:thumb-latest &',
              '[ -f /tmp/built-video ] && docker push $PRIVATE_HEAVY_URI:video-$COMMIT &',
              '[ -f /tmp/built-video ] && docker push $PRIVATE_HEAVY_URI:video-latest &',
              '[ -f /tmp/built-mediaprocess ] && docker push $PRIVATE_HEAVY_URI:mediaprocess-$COMMIT &',
              '[ -f /tmp/built-mediaprocess ] && docker push $PRIVATE_HEAVY_URI:mediaprocess-latest &',
              '[ -f /tmp/built-webhook ] && docker push $PRIVATE_WEBHOOK_URI:webhook-$COMMIT &',
              '[ -f /tmp/built-webhook ] && docker push $PRIVATE_WEBHOOK_URI:webhook-latest &',
              '[ -f /tmp/built-oauth ] && docker push $PRIVATE_OAUTH_URI:oauth-$COMMIT &',
              '[ -f /tmp/built-oauth ] && docker push $PRIVATE_OAUTH_URI:oauth-latest &',
              // Risk 37: Public repo pushes removed — app-specific images stay in private repos only.
              'wait',
              'ENDPUSH',
            ].join('\n'),
            'bash /tmp/push.sh',
            'export API_TAG=$([ -f /tmp/built-api ] && echo "api-$COMMIT" || echo "api-latest")',
            'export TRIAGE_TAG=$([ -f /tmp/built-triage ] && echo "triage-$COMMIT" || echo "triage-latest")',
            'export DESC_TAG=$([ -f /tmp/built-desc ] && echo "desc-$COMMIT" || echo "desc-latest")',
            'export DOWNLOAD_TAG=$([ -f /tmp/built-download ] && echo "download-$COMMIT" || echo "download-latest")',
            'export PUBLISH_TAG=$([ -f /tmp/built-publish ] && echo "publish-$COMMIT" || echo "publish-latest")',
            'export ENHANCE_TAG=$([ -f /tmp/built-enhance ] && echo "enhance-$COMMIT" || echo "enhance-latest")',
            'export THUMB_TAG=$([ -f /tmp/built-thumb ] && echo "thumb-$COMMIT" || echo "thumb-latest")',
            'export SELECT_TAG=$([ -f /tmp/built-select ] && echo "select-$COMMIT" || echo "select-latest")',
            'export VIDEO_TAG=$([ -f /tmp/built-video ] && echo "video-$COMMIT" || echo "video-latest")',
            'export MEDIAPROCESS_TAG=$([ -f /tmp/built-mediaprocess ] && echo "mediaprocess-$COMMIT" || echo "mediaprocess-latest")',
            'export WEBHOOK_TAG=$([ -f /tmp/built-webhook ] && echo "webhook-$COMMIT" || echo "webhook-latest")',
            'export OAUTH_TAG=$([ -f /tmp/built-oauth ] && echo "oauth-$COMMIT" || echo "oauth-latest")',
            `echo '{"apiImage":"'$PRIVATE_LIGHT_URI:$API_TAG'","triageImage":"'$PRIVATE_LIGHT_URI:$TRIAGE_TAG'","descImage":"'$PRIVATE_LIGHT_URI:$DESC_TAG'","downloadImage":"'$PRIVATE_LIGHT_URI:$DOWNLOAD_TAG'","publishImage":"'$PRIVATE_LIGHT_URI:$PUBLISH_TAG'","enhanceImage":"'$PRIVATE_LIGHT_URI:$ENHANCE_TAG'","thumbImage":"'$PRIVATE_HEAVY_URI:$THUMB_TAG'","selectImage":"'$PRIVATE_HEAVY_URI:$SELECT_TAG'","videoImage":"'$PRIVATE_HEAVY_URI:$VIDEO_TAG'","mediaprocessImage":"'$PRIVATE_HEAVY_URI:$MEDIAPROCESS_TAG'","webhookImage":"'$PRIVATE_WEBHOOK_URI:$WEBHOOK_TAG'","oauthImage":"'$PRIVATE_OAUTH_URI:$OAUTH_TAG'","commit":"'$COMMIT'"}' > imageDetail.json`,
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

  // ECR grants
  props.lightEcrRepo.grantPullPush(project);
  props.heavyEcrRepo.grantPullPush(project);
  props.webhookEcrRepo.grantPullPush(project);
  props.oauthEcrRepo.grantPullPush(project);

  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'ecr:BatchGetImage',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchCheckLayerAvailability',
      ],
      resources: [`arn:aws:ecr:${props.region}:${props.account}:repository/static-ffmpeg-cache`],
    }),
  );

  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }),
  );

  // Risk 29: Scope ECR Public operations. Account-level actions require '*' per AWS docs.
  // Repository-level actions are scoped to specific public repo ARNs.
  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'ecr-public:GetAuthorizationToken',
        'ecr-public:DescribeRegistries',
      ],
      resources: ['*'], // Required by AWS — these are account-level operations
    }),
  );

  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        'ecr-public:BatchCheckLayerAvailability',
        'ecr-public:InitiateLayerUpload',
        'ecr-public:UploadLayerPart',
        'ecr-public:CompleteLayerUpload',
        'ecr-public:PutImage',
      ],
      resources: [
        `arn:aws:ecr-public::${props.account}:repository/${props.publicLightRepoName}`,
        `arn:aws:ecr-public::${props.account}:repository/${props.publicHeavyRepoName}`,
      ],
    }),
  );

  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['sts:GetServiceBearerToken'],
      resources: ['*'], // Required by AWS — account-level operation
    }),
  );

  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${props.region}:${props.account}:parameter/ai-social-media/last-build-commit`],
    }),
  );

  return project;
}
