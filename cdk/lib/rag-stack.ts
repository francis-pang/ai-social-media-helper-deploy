import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Construct } from 'constructs';

const RAG_QUERY_LAMBDA_ARN_PARAM = '/ai-social-media/rag-query-lambda-arn';

/** Processing Lambdas from BackendStack for cross-stack wiring */
export interface ProcessingLambdasRef {
  apiHandler: lambda.IFunction;
  triageProcessor: lambda.Function;
  selectionProcessor: lambda.Function;
  descriptionProcessor: lambda.Function;
  downloadProcessor: lambda.IFunction;
  publishProcessor: lambda.IFunction;
  thumbnailProcessor: lambda.IFunction;
  enhancementProcessor: lambda.IFunction;
  videoProcessor: lambda.IFunction;
  mediaProcessProcessor: lambda.IFunction;
}

export interface RagStackProps extends cdk.StackProps {
  /** Processing Lambdas from BackendStack — for events:PutEvents and RAG_QUERY_LAMBDA_ARN */
  lambdas: ProcessingLambdasRef;
  /** ECR light repository for RAG Lambda images (used when localImages is not set) */
  lightEcrRepo: ecr.IRepository;
}

/**
 * RagStack creates the RAG (Retrieval-Augmented Generation) infrastructure:
 * Aurora Serverless v2 (pgvector), DynamoDB preference profiles + staging,
 * EventBridge + SQS ingest, 3 RAG Lambdas (ingest, query, profile).
 *
 * DDR-068: Daily batch architecture — ingest writes raw feedback to DynamoDB
 * staging table; profile Lambda runs daily to embed, insert to Aurora, build
 * profile, then stop Aurora. Auto-stop and status Lambdas removed.
 */
export class RagStack extends cdk.Stack {
  public readonly ragQueryLambda: lambda.Function;
  public readonly ragProfilesTable: dynamodb.Table;
  public readonly ragStagingTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: RagStackProps) {
    super(scope, id, props);

    const useLocalImages = this.node.tryGetContext('localImages') === 'true';
    const lambdaCodeRoot = path.join(__dirname, '..', '..', '..', 'ai-social-media-helper');

    // =========================================================================
    // 1. VPC — minimal for Aurora (2 AZs, private subnets only, no NAT)
    // =========================================================================
    const vpc = new ec2.Vpc(this, 'RagVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // =========================================================================
    // 2. Aurora Serverless v2 cluster (PostgreSQL, Data API)
    // =========================================================================
    const auroraCluster = new rds.DatabaseCluster(this, 'RagAuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_8,
      }),
      writer: rds.ClusterInstance.serverlessV2('writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 2,
      defaultDatabaseName: 'ragdb',
      enableDataApi: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const auroraSecret = auroraCluster.secret!;

    // =========================================================================
    // 3. DynamoDB tables
    // =========================================================================

    // 3a. rag-preference-profiles — pre-computed preference profile + caption examples
    this.ragProfilesTable = new dynamodb.Table(this, 'RagPreferenceProfiles', {
      tableName: 'rag-preference-profiles',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 3b. rag-ingest-staging — raw ContentFeedback events awaiting daily batch (DDR-068)
    this.ragStagingTable = new dynamodb.Table(this, 'RagIngestStaging', {
      tableName: 'rag-ingest-staging',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // =========================================================================
    // 4. SQS Queue — rag-ingest-queue with DLQ
    // =========================================================================
    const dlq = new sqs.Queue(this, 'RagIngestDlq', {
      queueName: 'rag-ingest-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const ingestQueue = new sqs.Queue(this, 'RagIngestQueue', {
      queueName: 'rag-ingest-queue',
      visibilityTimeout: cdk.Duration.seconds(180),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    // =========================================================================
    // 5. EventBridge rule — ContentFeedback -> SQS
    // =========================================================================
    const contentFeedbackRule = new events.Rule(this, 'ContentFeedbackRule', {
      eventBus: events.EventBus.fromEventBusName(
        this,
        'DefaultBus',
        'default',
      ),
      eventPattern: {
        source: ['ai-social-media-helper'],
        detailType: ['ContentFeedback'],
      },
    });
    contentFeedbackRule.addTarget(new targets.SqsQueue(ingestQueue));

    // =========================================================================
    // 6. Shared env vars + Lambda factory
    // =========================================================================
    const ragBaseEnv: Record<string, string> = {
      AURORA_CLUSTER_ARN: auroraCluster.clusterArn,
      AURORA_SECRET_ARN: auroraSecret.secretArn,
      AURORA_DATABASE_NAME: 'ragdb',
      RAG_PROFILES_TABLE_NAME: this.ragProfilesTable.tableName,
    };

    const ragImageCode = (ecrTag: string, dir: string): lambda.DockerImageCode =>
      useLocalImages
        ? lambda.DockerImageCode.fromImageAsset(lambdaCodeRoot, { file: path.join(dir, 'Dockerfile') })
        : lambda.DockerImageCode.fromEcr(props.lightEcrRepo, { tagOrDigest: ecrTag });

    const createRagLambda = (
      id: string,
      dir: string,
      ecrTag: string,
      config: {
        description: string;
        memorySize: number;
        timeout: cdk.Duration;
        environment?: Record<string, string>;
      },
    ): lambda.DockerImageFunction =>
      new lambda.DockerImageFunction(this, id, {
        description: config.description,
        code: ragImageCode(ecrTag, dir),
        architecture: lambda.Architecture.ARM_64,
        memorySize: config.memorySize,
        timeout: config.timeout,
        ephemeralStorageSize: cdk.Size.mebibytes(512),
        environment: { ...ragBaseEnv, ...config.environment },
      });

    // --- rag-ingest-lambda (DDR-068: writes raw feedback to DynamoDB staging, no Bedrock/Aurora) ---
    const ragIngestLambda = createRagLambda('RagIngestLambda', 'cmd/rag-ingest-lambda', 'ragingest-latest', {
      description: 'RAG ingest — stages raw ContentFeedback from SQS to DynamoDB (DDR-068)',
      memorySize: 512,
      timeout: cdk.Duration.minutes(2),
      environment: {
        STAGING_TABLE_NAME: this.ragStagingTable.tableName,
      },
    });
    ragIngestLambda.addEventSource(new lambdaEventSources.SqsEventSource(ingestQueue));

    // --- rag-query-lambda (DDR-068: DynamoDB profile only, no Aurora fallback) ---
    this.ragQueryLambda = createRagLambda('RagQueryLambda', 'cmd/rag-query-lambda', 'ragquery-latest', {
      description: 'RAG query — returns pre-computed preference profile from DynamoDB (DDR-068)',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
    });

    // --- rag-profile-lambda (DDR-068: daily batch — embed, ingest to Aurora, build profile, stop Aurora) ---
    const ragProfileLambda = createRagLambda('RagProfileLambda', 'cmd/rag-profile-lambda', 'ragprofile-latest', {
      description: 'RAG profile — daily batch: stage→embed→Aurora→profile→cleanup→stop (DDR-068)',
      memorySize: 2048,
      timeout: cdk.Duration.minutes(10),
      environment: {
        SSM_API_KEY_PARAM: '/ai-social-media/prod/gemini-api-key',
        STAGING_TABLE_NAME: this.ragStagingTable.tableName,
        BEDROCK_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
      },
    });

    // =========================================================================
    // 7. EventBridge Schedule — daily profile build (DDR-068)
    // =========================================================================
    new events.Rule(this, 'RagProfileSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new targets.LambdaFunction(ragProfileLambda)],
    });

    // =========================================================================
    // 8. IAM Permissions
    // =========================================================================

    // Ingest Lambda: only needs staging table write
    this.ragStagingTable.grantWriteData(ragIngestLambda);

    // Query Lambda: only needs profiles table read
    this.ragProfilesTable.grantReadData(this.ragQueryLambda);

    // Profile Lambda: full access — Aurora Data API, profiles write, staging read+delete, Bedrock, SSM, RDS start/stop
    auroraCluster.grantDataApiAccess(ragProfileLambda);
    auroraSecret.grantRead(ragProfileLambda);
    this.ragProfilesTable.grantReadWriteData(ragProfileLambda);
    this.ragStagingTable.grantReadWriteData(ragProfileLambda);

    ragProfileLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );

    ragProfileLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:DescribeDBClusters', 'rds:StartDBCluster', 'rds:StopDBCluster'],
        resources: [auroraCluster.clusterArn],
      }),
    );

    const stack = cdk.Stack.of(this);
    ragProfileLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${stack.region}:${stack.account}:parameter/ai-social-media/prod/gemini-api-key`,
        ],
      }),
    );

    // =========================================================================
    // 9. Cross-stack wiring — existing Lambdas
    // =========================================================================
    const allProcessingLambdas = [
      props.lambdas.apiHandler,
      props.lambdas.triageProcessor,
      props.lambdas.selectionProcessor,
      props.lambdas.descriptionProcessor,
      props.lambdas.downloadProcessor,
      props.lambdas.publishProcessor,
      props.lambdas.thumbnailProcessor,
      props.lambdas.enhancementProcessor,
      props.lambdas.videoProcessor,
      props.lambdas.mediaProcessProcessor,
    ];

    const defaultEventBusArn = `arn:aws:events:${stack.region}:${stack.account}:event-bus/default`;
    for (const fn of allProcessingLambdas) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['events:PutEvents'],
          resources: [defaultEventBusArn],
        }),
      );
    }

    // SSM param for RAG_QUERY_LAMBDA_ARN — avoids circular dependency (RAG needs Backend's API; Backend would need RAG's ARN).
    // Lambdas read the param at runtime; grant ssm:GetParameter with hardcoded ARN to avoid stack dependency.
    new ssm.StringParameter(this, 'RagQueryLambdaArnParam', {
      parameterName: RAG_QUERY_LAMBDA_ARN_PARAM,
      stringValue: this.ragQueryLambda.functionArn,
      description: 'RAG Query Lambda ARN for triage/selection/description to invoke',
    });

    const ragQueryInvokeLambdas = [
      { fn: props.lambdas.triageProcessor, id: 'TriageProcessor' },
      { fn: props.lambdas.selectionProcessor, id: 'SelectionProcessor' },
      { fn: props.lambdas.descriptionProcessor, id: 'DescriptionProcessor' },
    ];
    for (const { fn, id } of ragQueryInvokeLambdas) {
      this.ragQueryLambda.addPermission('AllowInvokeFrom' + id, {
        principal: new iam.ServicePrincipal('lambda.amazonaws.com'),
        sourceArn: fn.functionArn,
      });
      fn.addEnvironment('RAG_QUERY_LAMBDA_ARN_PARAM', RAG_QUERY_LAMBDA_ARN_PARAM);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            `arn:aws:ssm:${stack.region}:${stack.account}:parameter${RAG_QUERY_LAMBDA_ARN_PARAM}`,
          ],
        }),
      );
    }

    // =========================================================================
    // Tag resources
    // =========================================================================
    cdk.Tags.of(this).add('Project', 'ai-social-media-helper');

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'RagClusterArn', {
      value: auroraCluster.clusterArn,
      description: 'Aurora RAG cluster ARN',
    });
    new cdk.CfnOutput(this, 'RagQueryLambdaArn', {
      value: this.ragQueryLambda.functionArn,
      description: 'RAG Query Lambda ARN',
    });
    new cdk.CfnOutput(this, 'RagStagingTableName', {
      value: this.ragStagingTable.tableName,
      description: 'RAG staging DynamoDB table name (DDR-068)',
    });
  }
}
