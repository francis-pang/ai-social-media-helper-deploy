#!/usr/bin/env bash
# C3: CDK validation script — checks for known failure patterns
# from the historical error catalog (DDR Section 6.2).
#
# See: DDR-055-deployment-automation.md (in app repo docs/design-decisions/)
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[validate-cdk]${NC} $*"; }
warn()  { echo -e "${YELLOW}[validate-cdk]${NC} $*"; }
error() { echo -e "${RED}[validate-cdk]${NC} $*"; }

# Find the CDK directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$CDK_DIR/lib"

FAILED=0

info "Running CDK validation checks..."
echo ""

# --- 1. Ban functionName on DockerImageFunction (DDR commit 460fbef) ---
# Custom functionName prevents CloudFormation from replacing Lambda functions
# during stack updates, causing UPDATE_ROLLBACK_FAILED.
info "Check: No custom functionName on DockerImageFunction..."
if grep -rn 'functionName' "$LIB_DIR"/*.ts 2>/dev/null | grep -i 'docker\|image' | grep -v '//.*functionName' | grep -v 'props\.' | grep -v '\.functionName'; then
  error "FAIL: Found custom functionName on Docker/Image function — this prevents Lambda replacement"
  error "  Fix: Remove functionName property; let CloudFormation manage the name"
  FAILED=1
else
  info "  PASSED"
fi
echo ""

# --- 2. Check --provenance=false in buildspec (DDR commit 037b837) ---
# Without --provenance=false, Docker produces OCI index manifests that Lambda cannot use.
info "Check: --provenance=false in Docker build commands..."
if grep -rn 'docker build' "$LIB_DIR"/*.ts 2>/dev/null | grep -v 'provenance=false' | grep -v '//'; then
  error "FAIL: Found docker build without --provenance=false"
  error "  Fix: Add --provenance=false to all docker build commands"
  FAILED=1
else
  info "  PASSED"
fi
echo ""

# --- 3. ECR_ACCOUNT_ID in heavy image builds (DDR commit 0b79423) ---
# Heavy images (with ffmpeg) need ECR_ACCOUNT_ID to pull the cached base image.
info "Check: ECR_ACCOUNT_ID in heavy image builds..."
if grep -n 'Dockerfile.heavy' "$LIB_DIR"/*.ts 2>/dev/null | head -1 > /dev/null 2>&1; then
  if ! grep -n 'ECR_ACCOUNT_ID' "$LIB_DIR"/*.ts 2>/dev/null | grep -q 'ECR_ACCOUNT_ID'; then
    error "FAIL: Heavy image builds found but ECR_ACCOUNT_ID not set"
    error "  Fix: Pass --build-arg ECR_ACCOUNT_ID=\$AWS_ACCOUNT_ID to heavy builds"
    FAILED=1
  else
    info "  PASSED"
  fi
else
  info "  PASSED (no heavy image builds found)"
fi
echo ""

# --- 4. Shell compatibility in buildspec (DDR commit 57086d7) ---
# CodeBuild uses /bin/sh by default. Bash-specific syntax (substring ${var:0:7})
# causes silent failures.
info "Check: No bash-specific syntax in buildspec commands..."
BASH_PATTERNS=(
  '\$\{[a-zA-Z_]*:[0-9]'     # ${var:0:7} substring
  '\[\[.*\]\]'                 # [[ ]] double brackets (bash-only)
  'declare\s+-[aAilrux]'      # declare with bash flags
  'local\s+-[aAilrux]'        # local with bash flags
)
BASH_FOUND=false
for pattern in "${BASH_PATTERNS[@]}"; do
  MATCHES=$(grep -rn "$pattern" "$LIB_DIR"/*.ts 2>/dev/null | grep -v '//' | grep -v 'pre-push\|setup\.sh\|validate' || true)
  if [ -n "$MATCHES" ]; then
    error "  Found bash-specific syntax: $MATCHES"
    BASH_FOUND=true
  fi
done
if [ "$BASH_FOUND" = "true" ]; then
  error "FAIL: Bash-specific syntax found in buildspec — CodeBuild uses /bin/sh"
  FAILED=1
else
  info "  PASSED"
fi
echo ""

# --- 5. Cross-stack log group conflicts (DDR commit 04ad39a) ---
# Log groups defined in multiple stacks cause "Resource already exists" errors.
info "Check: No duplicate log group names across stacks..."
LOG_GROUPS=$(grep -rhn "logGroupName:" "$LIB_DIR"/*.ts 2>/dev/null | grep -v '//' | sed "s/.*logGroupName:\s*['\"\`]//;s/['\"\`].*//" | sort)
DUPES=$(echo "$LOG_GROUPS" | sort | uniq -d)
if [ -n "$DUPES" ]; then
  error "FAIL: Duplicate log group names found across stacks:"
  echo "$DUPES" | while read -r dup; do
    error "  - $dup"
  done
  FAILED=1
else
  info "  PASSED"
fi
echo ""

# --- 6. Synthesized template validation ---
# If cdk.out or cdk-deploy-out exists, validate the templates
SYNTH_DIR="$CDK_DIR/cdk.out"
if [ -d "$SYNTH_DIR" ]; then
  info "Check: CloudFormation template validity..."
  TEMPLATE_ERRORS=0
  for template in "$SYNTH_DIR"/*.template.json; do
    if [ -f "$template" ]; then
      # Basic JSON validity
      if ! python3 -m json.tool "$template" > /dev/null 2>&1; then
        error "  Invalid JSON: $(basename "$template")"
        TEMPLATE_ERRORS=$((TEMPLATE_ERRORS + 1))
      fi
    fi
  done
  if [ "$TEMPLATE_ERRORS" -eq 0 ]; then
    info "  PASSED"
  else
    error "FAIL: $TEMPLATE_ERRORS invalid CloudFormation template(s)"
    FAILED=1
  fi
else
  warn "No synthesized templates found — run 'cdk synth' first"
fi
echo ""

# --- Summary ---
if [ "$FAILED" -ne 0 ]; then
  echo ""
  error "=== CDK VALIDATION FAILED ==="
  error "Fix the issues above before deploying."
  exit 1
fi

info "=== ALL CDK VALIDATIONS PASSED ==="
exit 0
