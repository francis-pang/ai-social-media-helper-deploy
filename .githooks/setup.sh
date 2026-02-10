#!/usr/bin/env bash
# Install git hooks for the deploy repo (ai-social-media-helper-deploy)
# Usage: .githooks/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Installing git hooks for ai-social-media-helper-deploy..."

# Configure git to use our hooks directory
git -C "$REPO_DIR" config core.hooksPath .githooks

# Ensure hooks are executable
chmod +x "$SCRIPT_DIR/pre-push"

echo "Done. Git hooks installed from .githooks/"
echo "  - pre-push: Full validation (C3) — tsc, cdk synth, cdk diff, validate-cdk.sh, secret scan"
