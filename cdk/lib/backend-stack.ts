import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';
import { Construct } from 'constructs';

export interface BackendStackProps extends cdk.StackProps {
  /** The S3 bucket for media uploads (from StorageStack) */
  mediaBucket: s3.IBucket;
  /** The DynamoDB table for session state (from StorageStack) */
  sessionsTable: dynamodb.ITable;
  /** CloudFront distribution domain for CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
  /** ECR Private light repository — API + Enhancement (from RegistryStack, DDR-046) */
  lightEcrRepo: ecr.IRepository;
  /** ECR Private heavy repository — Selection + Thumbnail + Video (from RegistryStack, DDR-046) */
  heavyEcrRepo: ecr.IRepository;
  /** ECR Public light repository (from RegistryStack, DDR-046) */
  publicLightEcrRepo: ecr.CfnPublicRepository;
  /** ECR Public heavy repository (from RegistryStack, DDR-046) */
  publicHeavyEcrRepo: ecr.CfnPublicRepository;
}

/**
 * BackendStack creates the multi-Lambda backend infrastructure (DDR-035).
 *
 * Components:
 * - 5 Lambda functions (API, Thumbnail, Selection, Enhancement, Video)
 * - 2 Step Functions state machines (SelectionPipeline, EnhancementPipeline)
 * - API Gateway HTTP API with Cognito JWT auth
 * - Cognito User Pool (no public signup)
 *
 * ECR repositories are owned by RegistryStack (DDR-046) and passed as props.
 * Container Registry Strategy (DDR-041):
 * - ECR Private: API handler (auth/prompts), Selection processor (proprietary algorithms)
 * - ECR Public: Enhancement processor (generic), Thumbnail + Video processors (generic ffmpeg)
 *
 * Security (DDR-028):
 * - Cognito User Pool with JWT authorizer (no public signup)
 * - Origin-verify shared secret (CloudFront -> Lambda)
 * - CORS locked to CloudFront domain
 * - API Gateway default throttling (100 req/s burst, 50 req/s steady)
 * - Per-Lambda IAM with least privilege
 */
export class BackendStack extends cdk.Stack {
  // API Gateway + Auth
  public readonly httpApi: apigwv2.HttpApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  // Lambda functions
  public readonly apiHandler: lambda.Function;
  public readonly thumbnailProcessor: lambda.Function;
  public readonly selectionProcessor: lambda.Function;
  public readonly enhancementProcessor: lambda.Function;
  public readonly videoProcessor: lambda.Function;

  // ECR repositories (from RegistryStack — DDR-046)
  public readonly lightEcrRepo: ecr.IRepository;
  public readonly heavyEcrRepo: ecr.IRepository;
  public readonly publicLightEcrRepo: ecr.CfnPublicRepository;
  public readonly publicHeavyEcrRepo: ecr.CfnPublicRepository;

  // Step Functions
  public readonly selectionPipeline: sfn.StateMachine;
  public readonly enhancementPipeline: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    // =========================================================================
    // Cognito User Pool (DDR-028 Problem 2)
    // =========================================================================
    // Self-signup disabled — the sole user is provisioned via AWS CLI:
    //   aws cognito-idp admin-create-user --user-pool-id <id> --username <email>
    //   aws cognito-idp admin-set-user-password --user-pool-id <id> --username <email> --password <pw> --permanent
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'AiSocialMediaUsers',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: 'AiSocialMediaWebClient',
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // SPA cannot keep a secret
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(7),
    });

    // =========================================================================
    // ECR Repositories (from RegistryStack — DDR-046)
    // =========================================================================
    this.lightEcrRepo = props.lightEcrRepo;
    this.heavyEcrRepo = props.heavyEcrRepo;
    this.publicLightEcrRepo = props.publicLightEcrRepo;
    this.publicHeavyEcrRepo = props.publicHeavyEcrRepo;

    // =========================================================================
    // Origin Verify Secret (DDR-028 Problem 1)
    // =========================================================================
    const originVerifySecret = cdk.Fn.select(2, cdk.Fn.split('/', this.stackId));

    // =========================================================================
    // Lambda Functions (DDR-035)
    // =========================================================================
    // All Lambdas reference ECR images from RegistryStack (DDR-046). The
    // pipeline (BackendPipelineStack) builds and pushes images, then updates
    // each Lambda to use its specific image tag.

    // Shared environment variables for all processing Lambdas
    const sharedEnv = {
      MEDIA_BUCKET_NAME: props.mediaBucket.bucketName,
      DYNAMO_TABLE_NAME: props.sessionsTable.tableName,
      SSM_API_KEY_PARAM: '/ai-social-media/prod/gemini-api-key',
    };

    // --- 1. API Lambda (DDR-035: 256 MB, 30s, DDR-041: ECR Private light) ---
    // Handles HTTP requests via API Gateway. Fast responses only.
    // For long-running work: starts Step Functions executions.
    this.apiHandler = new lambda.DockerImageFunction(this, 'ApiHandler', {
      code: lambda.DockerImageCode.fromEcr(this.lightEcrRepo, { tagOrDigest: 'api-latest' }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      environment: {
        ...sharedEnv,
        ORIGIN_VERIFY_SECRET: originVerifySecret,
        SSM_INSTAGRAM_TOKEN_PARAM: '/ai-social-media/prod/instagram-access-token',
        SSM_INSTAGRAM_USER_ID_PARAM: '/ai-social-media/prod/instagram-user-id',
        // State machine ARNs set after state machines are created (below)
      },
    });

    // --- 2. Thumbnail Lambda (DDR-035: 512 MB, 2 min, DDR-041: ECR Public heavy) ---
    // Invoked by Step Functions Map state — one invocation per media file.
    // Generates 400px thumbnail (image: Go resize, video: ffmpeg frame).
    this.thumbnailProcessor = new lambda.DockerImageFunction(this, 'ThumbnailProcessor', {
      // Uses select-latest as initial placeholder; pipeline updates to correct image
      code: lambda.DockerImageCode.fromEcr(this.heavyEcrRepo, { tagOrDigest: 'select-latest' }),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: sharedEnv,
    });

    // --- 3. Selection Lambda (DDR-035: 4 GB, 15 min, DDR-041: ECR Private heavy) ---
    // Invoked by Step Functions after thumbnails are generated.
    // Downloads all thumbnails, sends to Gemini for AI selection.
    this.selectionProcessor = new lambda.DockerImageFunction(this, 'SelectionProcessor', {
      code: lambda.DockerImageCode.fromEcr(this.heavyEcrRepo, { tagOrDigest: 'select-latest' }),
      timeout: cdk.Duration.minutes(15),
      memorySize: 4096,
      ephemeralStorageSize: cdk.Size.mebibytes(4096),
      environment: sharedEnv,
    });

    // --- 4. Enhancement Lambda (DDR-035: 2 GB, 5 min, DDR-041: ECR Public light) ---
    // Invoked by Step Functions Map state — one invocation per photo.
    // Sends photo to Gemini for AI image editing.
    this.enhancementProcessor = new lambda.DockerImageFunction(this, 'EnhancementProcessor', {
      // Uses api-latest as initial placeholder; pipeline updates to correct image
      code: lambda.DockerImageCode.fromEcr(this.lightEcrRepo, { tagOrDigest: 'api-latest' }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.mebibytes(2048),
      environment: sharedEnv,
    });

    // --- 5. Video Processing Lambda (DDR-035: 4 GB, 15 min, DDR-041: ECR Public heavy) ---
    // Invoked by Step Functions Map state — one invocation per video.
    // Downloads video, runs ffmpeg enhancement, uploads result.
    this.videoProcessor = new lambda.DockerImageFunction(this, 'VideoProcessor', {
      // Uses select-latest as initial placeholder; pipeline updates to correct image
      code: lambda.DockerImageCode.fromEcr(this.heavyEcrRepo, { tagOrDigest: 'select-latest' }),
      timeout: cdk.Duration.minutes(15),
      memorySize: 4096,
      ephemeralStorageSize: cdk.Size.mebibytes(10240), // 10 GB for large video files
      environment: sharedEnv,
    });

    // =========================================================================
    // IAM Permissions (DDR-035: least privilege per Lambda)
    // =========================================================================
    const allLambdas = [
      this.apiHandler,
      this.thumbnailProcessor,
      this.selectionProcessor,
      this.enhancementProcessor,
      this.videoProcessor,
    ];

    // All Lambdas: S3 read/write/delete + list on media bucket
    for (const fn of allLambdas) {
      props.mediaBucket.grantReadWrite(fn);
      props.mediaBucket.grantDelete(fn);
    }

    // All Lambdas: DynamoDB CRUD on sessions table
    for (const fn of allLambdas) {
      props.sessionsTable.grantReadWriteData(fn);
    }

    // All Lambdas: SSM read for Gemini API key
    const geminiKeyArn = `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/gemini-api-key`;
    for (const fn of allLambdas) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [geminiKeyArn],
        }),
      );
    }

    // API Lambda only: SSM read for Instagram credentials
    this.apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-access-token`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/ai-social-media/prod/instagram-user-id`,
        ],
      }),
    );

    // =========================================================================
    // Step Functions State Machines (DDR-035)
    // =========================================================================

    // --- Selection Pipeline ---
    // Map: generate thumbnails (parallel, per file) -> Selection Lambda (Gemini AI)
    const generateThumbnails = new tasks.LambdaInvoke(this, 'GenerateThumbnails', {
      lambdaFunction: this.thumbnailProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    generateThumbnails.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
    });

    const thumbnailMap = new sfn.Map(this, 'ThumbnailMap', {
      maxConcurrency: 20,
      itemsPath: '$.mediaKeys',
      resultPath: '$.thumbnailResults',
      itemSelector: {
        'sessionId.$': '$.sessionId',
        'mediaKey.$': '$$.Map.Item.Value',
      },
    });
    thumbnailMap.itemProcessor(generateThumbnails);

    const runSelection = new tasks.LambdaInvoke(this, 'RunSelection', {
      lambdaFunction: this.selectionProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    runSelection.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    const selectionDefinition = thumbnailMap.next(runSelection);

    this.selectionPipeline = new sfn.StateMachine(this, 'SelectionPipeline', {
      stateMachineName: 'AiSocialMediaSelectionPipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(selectionDefinition),
      timeout: cdk.Duration.minutes(30),
    });

    // --- Enhancement Pipeline ---
    // Parallel: (Map: enhance photos) + (Map: process videos)
    const enhancePhoto = new tasks.LambdaInvoke(this, 'EnhancePhoto', {
      lambdaFunction: this.enhancementProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    enhancePhoto.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
    });

    const photoMap = new sfn.Map(this, 'PhotoEnhancementMap', {
      maxConcurrency: 10,
      itemsPath: '$.photos',
      itemSelector: {
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'mediaKey.$': '$$.Map.Item.Value',
      },
    });
    photoMap.itemProcessor(enhancePhoto);

    const processVideo = new tasks.LambdaInvoke(this, 'ProcessVideo', {
      lambdaFunction: this.videoProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    processVideo.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    const videoMap = new sfn.Map(this, 'VideoProcessingMap', {
      maxConcurrency: 5,
      itemsPath: '$.videos',
      itemSelector: {
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'mediaKey.$': '$$.Map.Item.Value',
      },
    });
    videoMap.itemProcessor(processVideo);

    const parallelEnhance = new sfn.Parallel(this, 'ParallelEnhance', {
      resultPath: '$.enhancementResults',
    });
    parallelEnhance.branch(photoMap);
    parallelEnhance.branch(videoMap);

    this.enhancementPipeline = new sfn.StateMachine(this, 'EnhancementPipeline', {
      stateMachineName: 'AiSocialMediaEnhancementPipeline',
      definitionBody: sfn.DefinitionBody.fromChainable(parallelEnhance),
      timeout: cdk.Duration.minutes(30),
    });

    // API Lambda: permission to start both state machines
    this.apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [
          this.selectionPipeline.stateMachineArn,
          this.enhancementPipeline.stateMachineArn,
        ],
      }),
    );

    // Add state machine ARNs to API Lambda environment
    this.apiHandler.addEnvironment(
      'SELECTION_STATE_MACHINE_ARN',
      this.selectionPipeline.stateMachineArn,
    );
    this.apiHandler.addEnvironment(
      'ENHANCEMENT_STATE_MACHINE_ARN',
      this.enhancementPipeline.stateMachineArn,
    );

    // =========================================================================
    // API Gateway HTTP API (DDR-028: CORS lockdown + throttling)
    // =========================================================================
    const issuer = this.userPool.userPoolProviderUrl;
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('CognitoAuthorizer', issuer, {
      jwtAudience: [this.userPoolClient.userPoolClientId],
      identitySource: ['$request.header.Authorization'],
    });

    const allowedOrigins = props.cloudFrontDomain
      ? [`https://${props.cloudFrontDomain}`]
      : ['*']; // Fallback for initial deploy before CloudFront domain is known

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'AiSocialMediaApi',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: allowedOrigins,
        maxAge: cdk.Duration.hours(1),
      },
    });

    // API Gateway throttling (DDR-028 Problem 10)
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild as cdk.CfnResource;
    if (cfnStage) {
      cfnStage.addPropertyOverride('DefaultRouteSettings', {
        ThrottlingBurstLimit: 100,
        ThrottlingRateLimit: 50,
      });
    }

    // Route all /api/* requests to the API Lambda with JWT auth
    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      'LambdaIntegration',
      this.apiHandler,
    );

    this.httpApi.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
      authorizer: jwtAuthorizer,
    });

    // Health endpoint without auth (for monitoring/uptime checks)
    this.httpApi.addRoutes({
      path: '/api/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'API Gateway HTTP API endpoint URL',
    });

    new cdk.CfnOutput(this, 'ApiLambdaName', {
      value: this.apiHandler.functionName,
      description: 'API Lambda function name',
    });

    // ECR repo outputs are in RegistryStack (DDR-046)

    new cdk.CfnOutput(this, 'SelectionPipelineArn', {
      value: this.selectionPipeline.stateMachineArn,
      description: 'Selection Pipeline Step Functions ARN',
    });

    new cdk.CfnOutput(this, 'EnhancementPipelineArn', {
      value: this.enhancementPipeline.stateMachineArn,
      description: 'Enhancement Pipeline Step Functions ARN',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID (for admin-create-user)',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID (for frontend auth)',
    });

    new cdk.CfnOutput(this, 'OriginVerifySecret', {
      value: originVerifySecret,
      description: 'Origin verify shared secret (set on CloudFront custom header)',
    });
  }
}
