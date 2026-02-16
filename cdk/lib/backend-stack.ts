import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

import { ProcessingLambdas } from './constructs/processing-lambdas';
import { StepFunctionsPipelines } from './constructs/step-functions-pipelines';
import { ApiGateway } from './constructs/api-gateway';

export interface BackendStackProps extends cdk.StackProps {
  /** The S3 bucket for media uploads (from StorageStack) */
  mediaBucket: s3.IBucket;
  /** The DynamoDB table for session state (from StorageStack) */
  sessionsTable: dynamodb.ITable;
  /** DynamoDB table for per-file processing results (DDR-061) */
  fileProcessingTable: dynamodb.ITable;
  /** MediaProcess Lambda (from StorageStack — DDR-061, lives there for S3 event notification) */
  mediaProcessProcessor: lambda.IFunction;
  /** CloudFront distribution domain for CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
  /** ECR Private light repository — API + domain Lambdas (from RegistryStack, DDR-046) */
  lightEcrRepo: ecr.IRepository;
  /** ECR Private heavy repository — Selection + Thumbnail + Video (from RegistryStack, DDR-046) */
  heavyEcrRepo: ecr.IRepository;
  /** ECR Public light repository (from RegistryStack, DDR-046) */
  publicLightEcrRepo: ecr.CfnPublicRepository;
  /** ECR Public heavy repository (from RegistryStack, DDR-046) */
  publicHeavyEcrRepo: ecr.CfnPublicRepository;
}

/**
 * BackendStack composes three constructs into the backend infrastructure (DDR-035, DDR-053).
 *
 * Constructs:
 * - ProcessingLambdas: 9 Lambda functions + IAM (constructs/processing-lambdas.ts)
 * - StepFunctionsPipelines: 4 state machines (constructs/step-functions-pipelines.ts)
 * - ApiGateway: Cognito + HTTP API + routes (constructs/api-gateway.ts)
 *
 * This orchestrator wires cross-construct dependencies:
 * - Step Functions ARNs → API Lambda environment variables
 * - Domain Lambda ARNs → API Lambda environment variables
 * - API Lambda → Step Functions start-execution permission
 *
 * ECR repositories are owned by RegistryStack (DDR-046) and passed as props.
 */
export class BackendStack extends cdk.Stack {
  // API Gateway + Auth (from ApiGateway construct)
  public readonly httpApi: apigwv2.HttpApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  // Lambda functions (from ProcessingLambdas construct)
  public readonly apiHandler: lambda.Function;
  public readonly triageProcessor: lambda.Function;
  public readonly descriptionProcessor: lambda.Function;
  public readonly downloadProcessor: lambda.Function;
  public readonly publishProcessor: lambda.Function;
  public readonly thumbnailProcessor: lambda.Function;
  public readonly selectionProcessor: lambda.Function;
  public readonly enhancementProcessor: lambda.Function;
  public readonly videoProcessor: lambda.Function;
  public readonly mediaProcessProcessor: lambda.IFunction;

  // ECR repositories (from RegistryStack — DDR-046)
  public readonly lightEcrRepo: ecr.IRepository;
  public readonly heavyEcrRepo: ecr.IRepository;
  public readonly publicLightEcrRepo: ecr.CfnPublicRepository;
  public readonly publicHeavyEcrRepo: ecr.CfnPublicRepository;

  // Step Functions (from StepFunctionsPipelines construct)
  public readonly selectionPipeline: sfn.StateMachine;
  public readonly enhancementPipeline: sfn.StateMachine;
  public readonly triagePipeline: sfn.StateMachine;
  public readonly publishPipeline: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    // Store ECR repo references for cross-stack access
    this.lightEcrRepo = props.lightEcrRepo;
    this.heavyEcrRepo = props.heavyEcrRepo;
    this.publicLightEcrRepo = props.publicLightEcrRepo;
    this.publicHeavyEcrRepo = props.publicHeavyEcrRepo;

    // =====================================================================
    // 1. Processing Lambdas (9 functions + IAM)
    // =====================================================================
    // Security: Cryptographically random origin-verify secret (Risk 5).
    // Replaces the previous stack-ID-derived secret which was predictable.
    // Stored in Secrets Manager (encrypted at rest, auditable via CloudTrail).
    const originSecret = new secretsmanager.Secret(this, 'OriginVerifySecret', {
      secretName: 'ai-social-media/origin-verify-secret',
      description: 'Cryptographically random origin-verify secret for CloudFront → API Gateway authentication',
      generateSecretString: {
        excludePunctuation: true,
        passwordLength: 32,
      },
    });
    const originVerifySecret = originSecret.secretValue.unsafeUnwrap();

    const lambdas = new ProcessingLambdas(this, 'Lambdas', {
      mediaBucket: props.mediaBucket,
      sessionsTable: props.sessionsTable,
      fileProcessingTable: props.fileProcessingTable,
      lightEcrRepo: props.lightEcrRepo,
      heavyEcrRepo: props.heavyEcrRepo,
      originVerifySecret,
    });
    // MediaProcess Lambda lives in StorageStack (for S3 event notification); re-export for pipeline

    // Re-export Lambda references for cross-stack access
    this.apiHandler = lambdas.apiHandler;
    this.triageProcessor = lambdas.triageProcessor;
    this.descriptionProcessor = lambdas.descriptionProcessor;
    this.downloadProcessor = lambdas.downloadProcessor;
    this.publishProcessor = lambdas.publishProcessor;
    this.thumbnailProcessor = lambdas.thumbnailProcessor;
    this.selectionProcessor = lambdas.selectionProcessor;
    this.enhancementProcessor = lambdas.enhancementProcessor;
    this.videoProcessor = lambdas.videoProcessor;
    this.mediaProcessProcessor = props.mediaProcessProcessor;

    // =====================================================================
    // 2. Step Functions Pipelines (4 state machines)
    // =====================================================================
    const pipelines = new StepFunctionsPipelines(this, 'Pipelines', {
      thumbnailProcessor: lambdas.thumbnailProcessor,
      selectionProcessor: lambdas.selectionProcessor,
      enhancementProcessor: lambdas.enhancementProcessor,
      videoProcessor: lambdas.videoProcessor,
      triageProcessor: lambdas.triageProcessor,
      publishProcessor: lambdas.publishProcessor,
    });

    // Re-export pipeline references for cross-stack access
    this.selectionPipeline = pipelines.selectionPipeline;
    this.enhancementPipeline = pipelines.enhancementPipeline;
    this.triagePipeline = pipelines.triagePipeline;
    this.publishPipeline = pipelines.publishPipeline;

    // =====================================================================
    // 3. API Gateway + Cognito Auth
    // =====================================================================
    const api = new ApiGateway(this, 'Api', {
      apiHandler: lambdas.apiHandler,
      cloudFrontDomain: props.cloudFrontDomain,
    });

    this.httpApi = api.httpApi;
    this.userPool = api.userPool;
    this.userPoolClient = api.userPoolClient;

    // =====================================================================
    // Cross-construct wiring
    // =====================================================================
    // API Lambda: permission to start all state machines
    this.apiHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [
          pipelines.selectionPipeline.stateMachineArn,
          pipelines.enhancementPipeline.stateMachineArn,
          pipelines.triagePipeline.stateMachineArn,
          pipelines.publishPipeline.stateMachineArn,
        ],
      }),
    );

    // Inject state machine ARNs into API Lambda environment
    this.apiHandler.addEnvironment(
      'SELECTION_STATE_MACHINE_ARN',
      pipelines.selectionPipeline.stateMachineArn,
    );
    this.apiHandler.addEnvironment(
      'ENHANCEMENT_STATE_MACHINE_ARN',
      pipelines.enhancementPipeline.stateMachineArn,
    );
    this.apiHandler.addEnvironment(
      'TRIAGE_STATE_MACHINE_ARN',
      pipelines.triagePipeline.stateMachineArn,
    );
    this.apiHandler.addEnvironment(
      'PUBLISH_STATE_MACHINE_ARN',
      pipelines.publishPipeline.stateMachineArn,
    );

    this.apiHandler.addEnvironment(
      'FILE_PROCESSING_TABLE_NAME',
      props.fileProcessingTable.tableName,
    );
    lambdas.triageProcessor.addEnvironment(
      'FILE_PROCESSING_TABLE_NAME',
      props.fileProcessingTable.tableName,
    );

    // Inject domain-specific Lambda ARNs for async dispatch (DDR-053)
    this.apiHandler.addEnvironment(
      'DESCRIPTION_LAMBDA_ARN',
      lambdas.descriptionProcessor.functionArn,
    );
    this.apiHandler.addEnvironment(
      'DOWNLOAD_LAMBDA_ARN',
      lambdas.downloadProcessor.functionArn,
    );
    this.apiHandler.addEnvironment(
      'ENHANCE_LAMBDA_ARN',
      lambdas.enhancementProcessor.functionArn,
    );

    // =====================================================================
    // SSM Parameters for cross-stack decoupling (DDR-054: deploy speed)
    // =====================================================================
    // These values are stable after first deploy. FrontendStack reads them
    // from SSM instead of taking cross-stack props, removing the
    // Backend → Frontend dependency from the CDK graph.
    new ssm.StringParameter(this, 'ApiEndpointParam', {
      parameterName: '/ai-social-media/api-endpoint',
      stringValue: this.httpApi.apiEndpoint,
      description: 'API Gateway endpoint URL (consumed by FrontendStack via SSM)',
    });
    // Origin-verify secret is now in Secrets Manager (Risk 5).
    // FrontendStack reads directly from Secrets Manager by name.

    // =====================================================================
    // CloudFormation Outputs
    // =====================================================================
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.httpApi.apiEndpoint,
      description: 'API Gateway HTTP API endpoint URL',
    });

    new cdk.CfnOutput(this, 'ApiLambdaName', {
      value: lambdas.apiHandler.functionName,
      description: 'API Lambda function name',
    });

    new cdk.CfnOutput(this, 'TriageLambdaName', {
      value: lambdas.triageProcessor.functionName,
      description: 'Triage Lambda function name (DDR-053)',
    });

    new cdk.CfnOutput(this, 'MediaProcessLambdaName', {
      value: props.mediaProcessProcessor.functionName,
      description: 'MediaProcess Lambda function name (DDR-061)',
    });

    new cdk.CfnOutput(this, 'DescriptionLambdaName', {
      value: lambdas.descriptionProcessor.functionName,
      description: 'Description Lambda function name (DDR-053)',
    });

    new cdk.CfnOutput(this, 'DownloadLambdaName', {
      value: lambdas.downloadProcessor.functionName,
      description: 'Download Lambda function name (DDR-053)',
    });

    new cdk.CfnOutput(this, 'PublishLambdaName', {
      value: lambdas.publishProcessor.functionName,
      description: 'Publish Lambda function name (DDR-053)',
    });

    new cdk.CfnOutput(this, 'SelectionPipelineArn', {
      value: pipelines.selectionPipeline.stateMachineArn,
      description: 'Selection Pipeline Step Functions ARN',
    });

    new cdk.CfnOutput(this, 'EnhancementPipelineArn', {
      value: pipelines.enhancementPipeline.stateMachineArn,
      description: 'Enhancement Pipeline Step Functions ARN',
    });

    new cdk.CfnOutput(this, 'TriagePipelineArn', {
      value: pipelines.triagePipeline.stateMachineArn,
      description: 'Triage Pipeline Step Functions ARN (DDR-052)',
    });

    new cdk.CfnOutput(this, 'PublishPipelineArn', {
      value: pipelines.publishPipeline.stateMachineArn,
      description: 'Publish Pipeline Step Functions ARN (DDR-052)',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: api.userPool.userPoolId,
      description: 'Cognito User Pool ID (for admin-create-user)',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: api.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID (for frontend auth)',
    });

    // Risk 5: OriginVerifySecret CfnOutput removed — secret no longer exposed in console.
  }
}
