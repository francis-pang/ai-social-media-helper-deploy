# AI Social Media Helper CDK

CDK TypeScript app for deploying AI Social Media Helper infrastructure.

**Structure:** `lib/` (stacks), `lib/constructs/` (backend-build-project, backend-deploy-project, lambda-factory, processing-lambdas, etc.), `test/` (per-stack tests + test-helpers).

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
