# AI Social Media Helper Deploy

Infrastructure as Code (IaC) repository for deploying the cloud environment of AI Social Media Helper.

This repository is intentionally deployment-focused. Application source code lives in the companion repository:

- `ai-social-media-helper` (application code and runtime binaries)

## Repository Layout

- `cdk/` - AWS CDK TypeScript app that defines all infrastructure stacks and deployment pipelines
- `LICENSE` - project license

## Stack Overview

The CDK app defines these stacks:

| Stack ID | Purpose |
| --- | --- |
| `AiSocialMediaStorage` | Stateful resources: media/frontend/archive/artifact S3 buckets and DynamoDB sessions table |
| `AiSocialMediaRegistry` | ECR private/public repositories used by Lambda container images |
| `AiSocialMediaBackend` | API Gateway, Cognito, backend Lambda functions, Step Functions orchestration |
| `AiSocialMediaFrontend` | CloudFront + S3 frontend hosting with `/api/*` proxy behavior |
| `AiSocialMediaWebhook` | Meta webhook + OAuth Lambda/API infrastructure |
| `AiSocialMediaBackendPipeline` | CI/CD pipeline to build and deploy backend Lambda container images |
| `AiSocialMediaFrontendPipeline` | CI/CD pipeline to build and deploy frontend assets |
| `AiSocialMediaOperationsAlert` | CloudWatch alarms, SNS alerting, X-Ray tracing configuration |
| `AiSocialMediaOperationsMonitoring` | Log and metric archival pipeline (Firehose/Glue/streams) |
| `AiSocialMediaOperationsDashboard` | CloudWatch operations dashboard widgets |

## Prerequisites

- Node.js 22+ and npm
- AWS credentials for the target account (for example via `AWS_PROFILE`)
- CDK bootstrap completed for target account/region
- CodeStar connection ARN (for pipeline stacks)

## Quick Start

```bash
cd cdk
npm ci
npm run build
npx aws-cdk synth
```

If this account/region has not been bootstrapped yet:

```bash
cd cdk
npx aws-cdk bootstrap
```

## Configuration

- CDK app entrypoint: `cdk/bin/cdk.ts`
- Default region fallback is `us-east-1` when `CDK_DEFAULT_REGION` is unset
- `CODESTAR_CONNECTION_ARN` can be provided via environment variable for pipeline stacks
- Metric archive is enabled by default; disable with CDK context:

```bash
npx aws-cdk deploy -c enableMetricArchive=false
```

## Deployment Commands

From `cdk/`, use the Makefile shortcuts:

```bash
# Daily default (core stacks only)
make deploy

# Full deploy (all stacks)
make deploy-full

# Grouped deploys
make deploy-core
make deploy-edge
make deploy-observability
make deploy-pipelines

# Per-stack deploys
make deploy-storage
make deploy-registry
make deploy-backend
make deploy-frontend
make deploy-webhook
make deploy-operations-alert
make deploy-operations-monitoring
make deploy-operations-dashboard
make deploy-fe-pipeline
make deploy-be-pipeline
```

Utilities:

```bash
cd cdk
make diff
make synth
npm test
```

## Notes

- Pipeline source actions are configured against `francis-pang/ai-social-media-helper` on branch `main`.
- Stateful resources are centralized in `AiSocialMediaStorage` to reduce accidental data loss during iterative deploys.

## License

See `LICENSE`.
