import * as cdk from 'aws-cdk-lib/core';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/**
 * RegistryStack owns all ECR repositories — both private and public (DDR-046).
 *
 * This stack deploys before any application stack (BackendStack, WebhookStack)
 * and contains NO Lambda functions. This breaks the chicken-and-egg circular
 * dependency where a DockerImageFunction requires an image that doesn't exist
 * until the pipeline (which depends on the application stack) pushes it.
 *
 * Bootstrap procedure for new ECR repos:
 * 1. Add the repo here and expose as a public property
 * 2. `cdk deploy AiSocialMediaRegistry`
 * 3. Build and push a seed image locally
 * 4. Reference the repo as a prop in the application stack
 * 5. `cdk deploy <ApplicationStack>`
 *
 * Container Registry Strategy (DDR-041):
 * - ECR Private: proprietary code (API, Selection, Webhook)
 * - ECR Public: generic utilities (Enhancement, Thumbnail, Video)
 *
 * Layer sharing strategy (DDR-035):
 * - Light repos: AL2023 base only (~55 MB)
 * - Heavy repos: AL2023 base + ffmpeg (~175 MB)
 */
export class RegistryStack extends cdk.Stack {
  // --- ECR Private (proprietary code — DDR-041) ---
  /** Light images: API Lambda, Enhancement Lambda (no ffmpeg) */
  public readonly lightEcrRepo: ecr.Repository;
  /** Heavy images: Selection, Thumbnail, Video Lambdas (with ffmpeg) */
  public readonly heavyEcrRepo: ecr.Repository;
  /** Webhook Lambda (dedicated repo — DDR-044) */
  public readonly webhookEcrRepo: ecr.Repository;
  /** OAuth Lambda (dedicated repo — DDR-048) */
  public readonly oauthEcrRepo: ecr.Repository;

  // --- ECR Public (generic code — DDR-041) ---
  /** Public light images: Enhancement Lambda (generic Gemini passthrough) */
  public readonly publicLightEcrRepo: ecr.CfnPublicRepository;
  /** Public heavy images: Thumbnail + Video Lambdas (generic ffmpeg) */
  public readonly publicHeavyEcrRepo: ecr.CfnPublicRepository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // ECR Private Repositories (DDR-041: proprietary code)
    // =========================================================================
    // Within each tier, light vs heavy maximizes Docker layer deduplication (DDR-035):
    // - Light: AL2023 base only (~40 MB shared)
    // - Heavy: AL2023 base + ffmpeg (~160 MB shared)

    this.lightEcrRepo = new ecr.Repository(this, 'LightImageRepo', {
      repositoryName: 'ai-social-media-lambda-light',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: 10, // Keep recent images for rollback (DDR-046)
          description: 'Keep only the 10 most recent images',
        },
      ],
    });

    this.heavyEcrRepo = new ecr.Repository(this, 'HeavyImageRepo', {
      repositoryName: 'ai-social-media-lambda-heavy',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: 10, // Keep recent images for rollback (DDR-046)
          description: 'Keep only the 10 most recent images',
        },
      ],
    });

    this.webhookEcrRepo = new ecr.Repository(this, 'WebhookImageRepo', {
      repositoryName: 'ai-social-media-webhook',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: 10, // Keep recent images for rollback (DDR-046)
          description: 'Keep only the 10 most recent images',
        },
      ],
    });

    this.oauthEcrRepo = new ecr.Repository(this, 'OAuthImageRepo', {
      repositoryName: 'ai-social-media-oauth',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        {
          maxImageCount: 10, // Keep recent images for rollback (DDR-046)
          description: 'Keep only the 10 most recent images',
        },
      ],
    });

    // =========================================================================
    // ECR Public Repositories (DDR-041: generic, non-proprietary code)
    // =========================================================================
    // CfnPublicRepository uses CloudFormation PascalCase for RepositoryCatalogData
    this.publicLightEcrRepo = new ecr.CfnPublicRepository(this, 'PublicLightImageRepo', {
      repositoryName: 'ai-social-media-lambda-light',
      repositoryCatalogData: {
        UsageText: 'Generic Lambda images (no ffmpeg) for AI social media helper.',
        AboutText: 'Light Lambda container images built on AL2023. Contains Go binaries without ffmpeg.',
        OperatingSystems: ['Linux'],
        Architectures: ['x86-64'],
      },
    });

    this.publicHeavyEcrRepo = new ecr.CfnPublicRepository(this, 'PublicHeavyImageRepo', {
      repositoryName: 'ai-social-media-lambda-heavy',
      repositoryCatalogData: {
        UsageText: 'Generic Lambda images (with ffmpeg) for AI social media helper.',
        AboutText: 'Heavy Lambda container images built on AL2023 with ffmpeg/ffprobe for media processing.',
        OperatingSystems: ['Linux'],
        Architectures: ['x86-64'],
      },
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'LightEcrRepoUri', {
      value: this.lightEcrRepo.repositoryUri,
      description: 'ECR Private repository URI for light Lambda images (API, Enhancement)',
    });

    new cdk.CfnOutput(this, 'HeavyEcrRepoUri', {
      value: this.heavyEcrRepo.repositoryUri,
      description: 'ECR Private repository URI for heavy Lambda images (Selection, Thumbnail, Video)',
    });

    new cdk.CfnOutput(this, 'WebhookEcrRepoUri', {
      value: this.webhookEcrRepo.repositoryUri,
      description: 'ECR Private repository URI for webhook Lambda image',
    });

    new cdk.CfnOutput(this, 'OAuthEcrRepoUri', {
      value: this.oauthEcrRepo.repositoryUri,
      description: 'ECR Private repository URI for OAuth Lambda image (DDR-048)',
    });

    new cdk.CfnOutput(this, 'PublicLightEcrRepoArn', {
      value: this.publicLightEcrRepo.attrArn,
      description: 'ECR Public repository ARN for light Lambda images (Enhancement)',
    });

    new cdk.CfnOutput(this, 'PublicHeavyEcrRepoArn', {
      value: this.publicHeavyEcrRepo.attrArn,
      description: 'ECR Public repository ARN for heavy Lambda images (Thumbnail, Video)',
    });
  }
}
