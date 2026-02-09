# CDK Deploy Makefile — optimized deployment targets (DDR-047)
#
# Quick reference:
#   make deploy              Full deploy (all stacks, parallel, skip change sets)
#   make deploy-backend      Deploy only BackendStack
#   make deploy-dev          Dev mode (hotswap, parallel)
#   make watch-backend       Auto-deploy on file changes
#   make synth               Synthesize CloudFormation templates
#   make diff                Preview changes across all stacks

.PHONY: deploy deploy-storage deploy-registry deploy-backend deploy-frontend
.PHONY: deploy-webhook deploy-operations-alert deploy-operations-monitoring
.PHONY: deploy-fe-pipeline deploy-be-pipeline
.PHONY: deploy-dev watch-backend watch-frontend synth diff

# --- Full Deploy (all stacks, parallel, skip change sets) ---
deploy:
	npx aws-cdk deploy --all --method=direct --concurrency 3 --require-approval never

# --- Per-Stack Targets (biggest single win for iteration speed) ---
# --exclusively: skip deploying dependencies that haven't changed
deploy-storage:
	npx aws-cdk deploy AiSocialMediaStorage --method=direct --exclusively

deploy-registry:
	npx aws-cdk deploy AiSocialMediaRegistry --method=direct --exclusively

deploy-backend:
	npx aws-cdk deploy AiSocialMediaBackend --method=direct --exclusively

deploy-frontend:
	npx aws-cdk deploy AiSocialMediaFrontend --method=direct --exclusively

deploy-webhook:
	npx aws-cdk deploy AiSocialMediaWebhook --method=direct --exclusively

deploy-operations-alert:
	npx aws-cdk deploy AiSocialMediaOperationsAlert --method=direct --exclusively

deploy-operations-monitoring:
	npx aws-cdk deploy AiSocialMediaOperationsMonitoring --method=direct --exclusively

deploy-fe-pipeline:
	npx aws-cdk deploy AiSocialMediaFrontendPipeline --method=direct --exclusively

deploy-be-pipeline:
	npx aws-cdk deploy AiSocialMediaBackendPipeline --method=direct --exclusively

# --- Dev Mode (hotswap skips CloudFormation for Lambda env vars, ---
# --- Step Functions definitions, API Gateway routes)              ---
deploy-dev:
	npx aws-cdk deploy --all --method=direct --hotswap --concurrency 3 --require-approval never

# --- Watch Mode (auto-deploy on CDK file changes) ---
watch-backend:
	npx aws-cdk watch AiSocialMediaBackend --hotswap

watch-frontend:
	npx aws-cdk watch AiSocialMediaFrontend --hotswap

# --- Utilities ---
synth:
	npx aws-cdk synth --quiet

diff:
	npx aws-cdk diff --all
