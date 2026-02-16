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

## Security Hardening

Security controls implemented across the CDK stacks:

| Control | Stack / File | Risk |
|---------|-------------|------|
| Crypto random origin-verify secret (Secrets Manager) | `backend-stack.ts` | Risk 5 |
| CORS locked to CloudFront domain (API GW + S3) | `api-gateway.ts`, `storage-stack.ts`, `cdk.ts` | Risk 7, 14 |
| CloudFront TLS 1.2+ with TLS 1.3 AEAD ciphers | `frontend-stack.ts`, `webhook-stack.ts` | Risk 16 |
| Cognito: implicit flow disabled, RETAIN policy | `api-gateway.ts` | Risk 20, 23 |
| ECR: scan-on-push + immutable tags | `registry-stack.ts` | Risk 27 |
| govulncheck blocks builds on known vulns | `backend-build-project.ts` | Risk 28 |
| ECR Public scoped IAM + no app image push | `backend-build-project.ts` | Risk 29, 37 |
| OAuth CSRF state parameter | `webhook-stack.ts` | Risk 19 |

### CORS Lockdown

CloudFront domain is resolved from SSM (`/ai-social-media/cloudfront-domain`) at CDK synth time. On the first deploy, this parameter does not exist — CORS temporarily allows `*`. After FrontendStack deploys and writes the domain to SSM, re-deploy Backend/Storage stacks to lock CORS.

Override with: `npx cdk deploy -c cloudFrontDomain=d1234.cloudfront.net`

### Manual Security Operations

Run `scripts/security-hardening.sh` for one-time AWS account hardening:
- Access key rotation (Risk 3)
- SSM SecureString migration (Risk 6)
- Account-level S3 Block Public Access (Risk 8)
- Security group closure (Risk 10)
- EBS default encryption (Risk 12)
- CloudTrail log validation + data events (Risk 22)
- VPC Flow Logs (Risk 36)
- Legacy bucket public access blocks (Risk 38)
