import * as cdk from 'aws-cdk-lib/core';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface LambdaDeployConfig {
  functionName: string;
  functionArn: string;
  imageKey: string;
}

export interface BackendDeployProjectProps {
  /** Lambda functions to update with their image keys from imageDetail.json */
  lambdas: LambdaDeployConfig[];
  /** AWS account ID */
  account: string;
  /** AWS region */
  region: string;
}

/**
 * Creates the CodeBuild project for the backend deploy stage (Lambda updates).
 * Parses imageDetail.json from build output and updates each Lambda with its image URI.
 */
export function createBackendDeployProject(
  scope: Construct,
  id: string,
  props: BackendDeployProjectProps,
): codebuild.PipelineProject {
  const { lambdas, account, region } = props;

  const toEnvVar = (imageKey: string) => imageKey.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');

  const project = new codebuild.PipelineProject(scope, id, {
    projectName: 'AiSocialMediaBackendDeploy',
    description: 'Deploy built Docker images to all 11 Lambda functions and wait for update completion',
    environment: {
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
      computeType: codebuild.ComputeType.SMALL,
    },
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        build: {
          commands: [
            ...lambdas.map(
              ({ imageKey }) =>
                `export ${toEnvVar(imageKey)}=$(python3 -c "import json; print(json.load(open('imageDetail.json'))['${imageKey}'])")`,
            ),
            ...lambdas.map(
              ({ functionName, imageKey }) => {
                const envVar = toEnvVar(imageKey);
                return `echo "Updating ${functionName}..." && aws lambda update-function-code --function-name ${functionName} --image-uri $${envVar}`;
              },
            ),
            ...lambdas.map(
              ({ functionName }) => `aws lambda wait function-updated --function-name ${functionName}`,
            ),
            'export SAVE_COMMIT=$(python3 -c "import json; d=json.load(open(\'imageDetail.json\')); print(d.get(\'commit\', \'\'))" 2>/dev/null || echo "$CODEBUILD_RESOLVED_SOURCE_VERSION")',
            '[ -n "$SAVE_COMMIT" ] && aws ssm put-parameter --name /ai-social-media/last-build-commit --value "$SAVE_COMMIT" --type String --overwrite || echo "Skipping SSM save (no commit available)"',
          ],
        },
      },
    }),
  });

  // Override buildspec: run all deploy logic in a single script so env vars persist.
  // CodeBuild may run each command in a separate shell; a single script guarantees
  // exports are visible to update commands. Use CODEBUILD_SRC_DIR for artifact path.
  const exportLines = lambdas
    .map(
      ({ imageKey }) =>
        `  export ${toEnvVar(imageKey)}=$(python3 -c "import json; print(json.load(open(\\"$IMG_JSON\\"))['${imageKey}'])")`,
    )
    .join('\n');
  const updateLines = lambdas
    .map(
      ({ functionName, imageKey }) => {
        const envVar = toEnvVar(imageKey);
        return [
          `  echo "Updating ${functionName}..."`,
          `  aws lambda update-function-code --function-name ${functionName} --image-uri "$${envVar}" || {`,
          `    echo "ERROR: Lambda update failed for ${functionName}";`,
          `    echo "  image_uri=$${envVar}";`,
          `    exit 1;`,
          `  }`,
        ].join('\n');
      },
    )
    .join('\n');
  const waitLines = lambdas
    .map(
      ({ functionName }) =>
        `  echo "Waiting for ${functionName}..." && aws lambda wait function-updated --function-name ${functionName}`,
    )
    .join('\n');

  const deployScript = [
    'set -euo pipefail',
    'trap \'echo ">>> DEPLOY FAILED at line $LINENO (last command: $BASH_COMMAND)"; exit 1\' ERR',
    'echo "=== Deploy env ==="; echo "CODEBUILD_SRC_DIR=${CODEBUILD_SRC_DIR:-<unset>}"; echo "PWD=$(pwd)"; echo "=== end ==="',
    'IMG_JSON="${CODEBUILD_SRC_DIR:-.}/imageDetail.json"',
    'if [ ! -f "$IMG_JSON" ]; then echo "ERROR: imageDetail.json not found at $IMG_JSON"; echo "Contents of dir:"; ls -la "${CODEBUILD_SRC_DIR:-.}/" 2>/dev/null || ls -la; exit 1; fi',
    'echo "=== imageDetail.json ==="; cat "$IMG_JSON" | python3 -m json.tool; echo "=== end ==="',
    exportLines,
    ...lambdas.map(
      ({ functionName, imageKey }) =>
        `  echo ">>> ${functionName} -> $${toEnvVar(imageKey)}"`,
    ),
    updateLines,
    waitLines,
    'SAVE_COMMIT=$(python3 -c "import json; d=json.load(open(\\"$IMG_JSON\\")); print(d.get(\\"commit\\", \\"\\"))" 2>/dev/null) || SAVE_COMMIT="$CODEBUILD_RESOLVED_SOURCE_VERSION"',
    '[ -n "$SAVE_COMMIT" ] && aws ssm put-parameter --name /ai-social-media/last-build-commit --value "$SAVE_COMMIT" --type String --overwrite --region ' +
      region +
      ' || echo "Skipping SSM save"',
    'echo "=== Deploy completed successfully: ' +
      lambdas.length +
      ' Lambdas updated ==="',
  ].join('\n');

  const deployCfn = project.node.defaultChild as cdk.CfnResource;
  deployCfn.addPropertyOverride(
    'Source.BuildSpec',
    JSON.stringify({
      version: '0.2',
      phases: {
        build: {
          commands: [
            "cat > /tmp/deploy.sh << 'DEPLOY_SCRIPT_END'\n" + deployScript + "\nDEPLOY_SCRIPT_END",
            'bash /tmp/deploy.sh',
          ],
        },
      },
    }),
  );

  // Lambda update permissions
  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['lambda:UpdateFunctionCode', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration'],
      resources: lambdas.map((l) => l.functionArn),
    }),
  );

  // SSM write for conditional builds
  project.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${region}:${account}:parameter/ai-social-media/last-build-commit`],
    }),
  );

  return project;
}
