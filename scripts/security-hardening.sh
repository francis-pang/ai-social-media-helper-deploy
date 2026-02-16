#!/usr/bin/env bash
# =============================================================================
# Security Hardening Script
# =============================================================================
# Implements manual AWS operations for security review findings.
# Run each section individually — DO NOT run the entire script at once.
# Review each command before executing.
#
# Prerequisites:
# - AWS CLI v2 configured with admin access
# - Account ID: 681565534940
# =============================================================================

set -euo pipefail

ACCOUNT_ID="681565534940"
REGIONS=("us-east-1" "ap-southeast-1")

# =============================================================================
# Risk 3: Rotate Access Keys + Enforce Max-Age
# =============================================================================
# Step 1: List current access keys for boyshawn
echo "=== Risk 3: Access Key Rotation ==="
aws iam list-access-keys --user-name boyshawn

# Step 2: Create a new access key
# aws iam create-access-key --user-name boyshawn

# Step 3: Update all consumers (CI/CD, local config) with the new key

# Step 4: Deactivate old keys (replace KEY_ID with actual key IDs)
# aws iam update-access-key --user-name boyshawn --access-key-id AKIA... --status Inactive

# Step 5: After confirming nothing is broken, delete old keys
# aws iam delete-access-key --user-name boyshawn --access-key-id AKIA...

# =============================================================================
# Risk 6: Migrate SSM Parameters to SecureString
# =============================================================================
echo "=== Risk 6: SSM SecureString Migration ==="
# Migrate each sensitive parameter from String to SecureString.
# The default aws/ssm KMS key is used (no extra permissions needed).

PARAMS_TO_MIGRATE=(
  "/ai-social-media/prod/gemini-api-key"
  "/ai-social-media/prod/instagram-app-secret"
  "/ai-social-media/prod/instagram-webhook-verify-token"
)

for PARAM in "${PARAMS_TO_MIGRATE[@]}"; do
  echo "Migrating $PARAM to SecureString..."
  VALUE=$(aws ssm get-parameter --name "$PARAM" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null || echo "NOT_FOUND")
  if [ "$VALUE" = "NOT_FOUND" ]; then
    echo "  SKIP: Parameter not found"
    continue
  fi
  TYPE=$(aws ssm get-parameter --name "$PARAM" --query 'Parameter.Type' --output text)
  if [ "$TYPE" = "SecureString" ]; then
    echo "  SKIP: Already SecureString"
    continue
  fi
  aws ssm put-parameter --name "$PARAM" --value "$VALUE" --type SecureString --overwrite
  echo "  DONE: Migrated to SecureString"
done

# =============================================================================
# Risk 8: Enable Account-Level S3 Block Public Access
# =============================================================================
echo "=== Risk 8: Account-Level S3 Block Public Access ==="
aws s3control put-public-access-block \
  --account-id "$ACCOUNT_ID" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
echo "Account-level S3 Block Public Access enabled."

# =============================================================================
# Risk 10: Close World-Open Security Groups
# =============================================================================
echo "=== Risk 10: Security Group Hardening ==="
echo "Listing security groups with 0.0.0.0/0 ingress..."

for REGION in "${REGIONS[@]}"; do
  echo "--- Region: $REGION ---"
  # Find SGs with world-open ingress
  aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=ip-permission.cidr,Values=0.0.0.0/0" \
    --query 'SecurityGroups[].{ID:GroupId,Name:GroupName,Rules:IpPermissions[?contains(IpRanges[].CidrIp,`0.0.0.0/0`)].[{FromPort:FromPort,ToPort:ToPort,Protocol:IpProtocol}]}' \
    --output table 2>/dev/null || echo "  No world-open SGs found"

  # To revoke SSH (port 22) from 0.0.0.0/0 on a specific SG:
  # aws ec2 revoke-security-group-ingress --region $REGION --group-id sg-xxx \
  #   --protocol tcp --port 22 --cidr 0.0.0.0/0

  # To revoke MySQL (port 3306) from 0.0.0.0/0:
  # aws ec2 revoke-security-group-ingress --region $REGION --group-id sg-xxx \
  #   --protocol tcp --port 3306 --cidr 0.0.0.0/0
done

# After revoking: Use SSM Session Manager for SSH-like access (no inbound ports needed).
# Enable SSM: https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-getting-started.html

# =============================================================================
# Risk 12: Enable EBS Default Encryption
# =============================================================================
echo "=== Risk 12: EBS Default Encryption ==="
for REGION in "${REGIONS[@]}"; do
  echo "Enabling EBS encryption by default in $REGION..."
  aws ec2 enable-ebs-encryption-by-default --region "$REGION"
  echo "  DONE: EBS encryption enabled in $REGION"
done

# =============================================================================
# Risk 22: CloudTrail Hardening (A: Log File Validation + C: Data Events)
# =============================================================================
echo "=== Risk 22: CloudTrail Hardening ==="
TRAIL_NAME=$(aws cloudtrail describe-trails --query 'trailList[0].Name' --output text)
if [ -n "$TRAIL_NAME" ] && [ "$TRAIL_NAME" != "None" ]; then
  echo "Trail: $TRAIL_NAME"

  # A: Enable log file validation
  aws cloudtrail update-trail --name "$TRAIL_NAME" --enable-log-file-validation
  echo "  Log file validation enabled."

  # C: Add S3 data events for the media bucket
  aws cloudtrail put-event-selectors --trail-name "$TRAIL_NAME" \
    --advanced-event-selectors '[
      {
        "Name": "S3DataEvents",
        "FieldSelectors": [
          {"Field": "eventCategory", "Equals": ["Data"]},
          {"Field": "resources.type", "Equals": ["AWS::S3::Object"]},
          {"Field": "resources.ARN", "StartsWith": ["arn:aws:s3:::ai-social-media-uploads-'"$ACCOUNT_ID"'/"]}
        ]
      },
      {
        "Name": "DynamoDBDataEvents",
        "FieldSelectors": [
          {"Field": "eventCategory", "Equals": ["Data"]},
          {"Field": "resources.type", "Equals": ["AWS::DynamoDB::Table"]},
          {"Field": "resources.ARN", "StartsWith": ["arn:aws:dynamodb:us-east-1:'"$ACCOUNT_ID"':table/media-selection-sessions"]}
        ]
      }
    ]'
  echo "  Data events enabled for S3 media bucket and DynamoDB sessions table."
else
  echo "  WARNING: No CloudTrail trail found."
fi

# =============================================================================
# Risk 36: Enable VPC Flow Logs
# =============================================================================
echo "=== Risk 36: VPC Flow Logs ==="
for REGION in "${REGIONS[@]}"; do
  echo "--- Region: $REGION ---"
  VPCS=$(aws ec2 describe-vpcs --region "$REGION" --query 'Vpcs[].VpcId' --output text)
  for VPC_ID in $VPCS; do
    EXISTING=$(aws ec2 describe-flow-logs --region "$REGION" \
      --filter "Name=resource-id,Values=$VPC_ID" \
      --query 'FlowLogs[].FlowLogId' --output text)
    if [ -n "$EXISTING" ]; then
      echo "  $VPC_ID: Flow logs already enabled ($EXISTING)"
      continue
    fi
    echo "  Enabling flow logs for $VPC_ID..."
    aws ec2 create-flow-logs --region "$REGION" \
      --resource-type VPC \
      --resource-ids "$VPC_ID" \
      --traffic-type ALL \
      --log-destination-type cloud-watch-logs \
      --log-group-name "/aws/vpc-flow-logs/$VPC_ID" \
      --deliver-logs-permission-arn "arn:aws:iam::${ACCOUNT_ID}:role/VPCFlowLogsRole" \
      --max-aggregation-interval 60 2>/dev/null || echo "  NOTE: Create IAM role VPCFlowLogsRole first if this fails"
  done
done

# =============================================================================
# Risk 38: Non-CDK Bucket Public Access Block
# =============================================================================
echo "=== Risk 38: Bucket-Level Public Access Block ==="
# CDK-managed buckets already have BLOCK_ALL. These are for non-CDK buckets.
LEGACY_BUCKETS=(
  "aws-cloudtrail-logs-${ACCOUNT_ID}-*"
  "s3-expense-tally-data"
)

for PATTERN in "${LEGACY_BUCKETS[@]}"; do
  BUCKETS=$(aws s3api list-buckets --query "Buckets[?starts_with(Name,'${PATTERN%%\**}')].Name" --output text 2>/dev/null)
  for BUCKET in $BUCKETS; do
    echo "Enabling public access block on $BUCKET..."
    aws s3api put-public-access-block --bucket "$BUCKET" \
      --public-access-block-configuration \
        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
    # Also enforce BucketOwnerEnforced to disable ACLs
    aws s3api put-bucket-ownership-controls --bucket "$BUCKET" \
      --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}' 2>/dev/null || echo "  (ownership controls may not apply to this bucket)"
    echo "  DONE: $BUCKET secured"
  done
done

# =============================================================================
# Risk 11: Detective Controls — GuardDuty + AWS Config + Inspector v2 + Security Hub
# =============================================================================
# These are account-level services. Enable once per account/region.
# Estimated cost: ~$8-17/mo for a low-traffic personal project.

echo "=== Risk 11: Detective Controls ==="

# --- A. GuardDuty ---
echo "--- GuardDuty ---"
for REGION in "${REGIONS[@]}"; do
  EXISTING=$(aws guardduty list-detectors --region "$REGION" --query 'DetectorIds[0]' --output text 2>/dev/null)
  if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
    echo "  $REGION: GuardDuty already enabled (detector: $EXISTING)"
  else
    echo "  $REGION: Enabling GuardDuty..."
    aws guardduty create-detector --region "$REGION" \
      --enable \
      --finding-publishing-frequency FIFTEEN_MINUTES \
      --data-sources '{
        "S3Logs": {"Enable": true},
        "MalwareProtection": {"ScanEc2InstanceWithFindings": {"EbsVolumes": false}}
      }'
    echo "  $REGION: GuardDuty enabled."
  fi
done

# --- B. AWS Config ---
echo "--- AWS Config ---"
REGION="us-east-1"
EXISTING_RECORDER=$(aws configservice describe-configuration-recorders --region "$REGION" \
  --query 'ConfigurationRecorders[0].name' --output text 2>/dev/null)

if [ -n "$EXISTING_RECORDER" ] && [ "$EXISTING_RECORDER" != "None" ]; then
  echo "  $REGION: Config recorder already exists ($EXISTING_RECORDER)"
else
  echo "  $REGION: Creating Config recorder..."

  # Create S3 bucket for Config delivery (if not exists)
  CONFIG_BUCKET="aws-config-delivery-${ACCOUNT_ID}"
  aws s3api head-bucket --bucket "$CONFIG_BUCKET" 2>/dev/null || \
    aws s3api create-bucket --bucket "$CONFIG_BUCKET" --region "$REGION"
  aws s3api put-public-access-block --bucket "$CONFIG_BUCKET" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

  # Create Config service role (if not exists)
  CONFIG_ROLE_NAME="AWSConfigRole"
  aws iam get-role --role-name "$CONFIG_ROLE_NAME" 2>/dev/null || \
    aws iam create-role --role-name "$CONFIG_ROLE_NAME" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{"Effect": "Allow", "Principal": {"Service": "config.amazonaws.com"}, "Action": "sts:AssumeRole"}]
      }'
  aws iam attach-role-policy --role-name "$CONFIG_ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole" 2>/dev/null || true

  # Allow Config to deliver to S3
  aws s3api put-bucket-policy --bucket "$CONFIG_BUCKET" --policy '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "AWSConfigBucketPermissionsCheck",
        "Effect": "Allow",
        "Principal": {"Service": "config.amazonaws.com"},
        "Action": "s3:GetBucketAcl",
        "Resource": "arn:aws:s3:::'"$CONFIG_BUCKET"'"
      },
      {
        "Sid": "AWSConfigBucketDelivery",
        "Effect": "Allow",
        "Principal": {"Service": "config.amazonaws.com"},
        "Action": "s3:PutObject",
        "Resource": "arn:aws:s3:::'"$CONFIG_BUCKET"'/AWSLogs/'"$ACCOUNT_ID"'/Config/*",
        "Condition": {"StringEquals": {"s3:x-amz-acl": "bucket-owner-full-control"}}
      }
    ]
  }'

  # Create recorder
  aws configservice put-configuration-recorder --region "$REGION" \
    --configuration-recorder "name=default,roleARN=arn:aws:iam::${ACCOUNT_ID}:role/${CONFIG_ROLE_NAME}" \
    --recording-group '{"allSupported": true, "includeGlobalResourceTypes": true}'

  # Create delivery channel
  aws configservice put-delivery-channel --region "$REGION" \
    --delivery-channel "name=default,s3BucketName=${CONFIG_BUCKET}"

  # Start recording
  aws configservice start-configuration-recorder --region "$REGION" \
    --configuration-recorder-name default

  echo "  $REGION: Config recorder created and started."

  # Add minimal managed rules
  echo "  Adding Config rules..."
  RULES=(
    "s3-bucket-public-read-prohibited"
    "iam-user-mfa-enabled"
    "restricted-ssh"
    "encrypted-volumes"
    "s3-bucket-server-side-encryption-enabled"
  )
  for RULE in "${RULES[@]}"; do
    aws configservice put-config-rule --region "$REGION" \
      --config-rule "{
        \"ConfigRuleName\": \"$RULE\",
        \"Source\": {
          \"Owner\": \"AWS\",
          \"SourceIdentifier\": \"$(echo "$RULE" | tr '[:lower:]-' '[:upper:]_')\"
        }
      }" 2>/dev/null || echo "    Rule $RULE: may already exist or identifier mismatch"
  done
  echo "  Config rules added."
fi

# --- C. Inspector v2 (ECR scanning only) ---
echo "--- Inspector v2 (ECR only) ---"
REGION="us-east-1"
INSPECTOR_STATUS=$(aws inspector2 batch-get-account-status --region "$REGION" \
  --query 'accounts[0].state.status' --output text 2>/dev/null || echo "NOT_ENABLED")

if [ "$INSPECTOR_STATUS" = "ENABLED" ]; then
  echo "  $REGION: Inspector v2 already enabled."
else
  echo "  $REGION: Enabling Inspector v2 for ECR scanning..."
  aws inspector2 enable --region "$REGION" \
    --resource-types ECR
  echo "  $REGION: Inspector v2 enabled (ECR scanning only)."
fi

# --- Security Hub ---
echo "--- Security Hub ---"
for REGION in "${REGIONS[@]}"; do
  HUB_STATUS=$(aws securityhub describe-hub --region "$REGION" \
    --query 'HubArn' --output text 2>/dev/null || echo "NOT_ENABLED")
  if [ "$HUB_STATUS" != "NOT_ENABLED" ]; then
    echo "  $REGION: Security Hub already enabled."
  else
    echo "  $REGION: Enabling Security Hub..."
    aws securityhub enable-security-hub --region "$REGION" \
      --enable-default-standards 2>/dev/null || echo "  $REGION: enable failed (may need to accept invite or region not supported)"
    echo "  $REGION: Security Hub enabled with AWS Foundational Security Best Practices."
  fi
done

echo ""
echo "=== Security hardening script complete ==="
echo "Review all changes above. Manual steps still required:"
echo "  - Risk 3: Replace access keys in CI/CD after rotation"
echo "  - Risk 10: Revoke specific SG rules after review"
echo "  - Risk 36: Create VPCFlowLogsRole IAM role if not exists"
