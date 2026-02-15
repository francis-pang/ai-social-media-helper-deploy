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
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
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

  // Override buildspec with explicit env var names (CodeBuild runs each command in shell, so
  // variable substitution in the initial buildSpec doesn't work for dynamic lambdas list).
  const exportCommands = lambdas.map(
    ({ imageKey }) =>
      `export ${toEnvVar(imageKey)}=$(python3 -c "import json; print(json.load(open('imageDetail.json'))['${imageKey}'])")`,
  );
  const updateCommands = lambdas.map(
    ({ functionName, imageKey }) => {
      const envVar = toEnvVar(imageKey);
      return `echo "Updating ${functionName}..." && aws lambda update-function-code --function-name ${functionName} --image-uri $${envVar}`;
    },
  );
  const waitCommands = lambdas.map(({ functionName }) =>
    `aws lambda wait function-updated --function-name ${functionName}`,
  );

  const deployCfn = project.node.defaultChild as cdk.CfnResource;
  deployCfn.addPropertyOverride(
    'Source.BuildSpec',
    JSON.stringify({
      version: '0.2',
      phases: {
        build: {
          commands: [
            ...exportCommands,
            ...updateCommands,
            ...waitCommands,
            'export SAVE_COMMIT=$(python3 -c "import json; d=json.load(open(\'imageDetail.json\')); print(d.get(\'commit\', \'\'))" 2>/dev/null || echo "$CODEBUILD_RESOLVED_SOURCE_VERSION")',
            '[ -n "$SAVE_COMMIT" ] && aws ssm put-parameter --name /ai-social-media/last-build-commit --value "$SAVE_COMMIT" --type String --overwrite || echo "Skipping SSM save (no commit available)"',
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
