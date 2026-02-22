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
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
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
  /** HTTP API from BackendStack — for /api/rag/status route */
  httpApi: apigwv2.HttpApi;
  /** ECR light repository for RAG Lambda images (used when localImages is not set) */
  lightEcrRepo: ecr.IRepository;
}

/**
 * RagStack creates the RAG (Retrieval-Augmented Generation) infrastructure:
 * Aurora Serverless v2 (pgvector), DynamoDB preference profiles, EventBridge + SQS ingest,
 * 5 RAG Lambdas (ingest, query, status, autostop, profile), and API route.
 */
export class RagStack extends cdk.Stack {
  public readonly ragQueryLambda: lambda.Function;
  public readonly ragProfilesTable: dynamodb.Table;

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
    // 3. DynamoDB table — rag-preference-profiles
    // =========================================================================
    this.ragProfilesTable = new dynamodb.Table(this, 'RagPreferenceProfiles', {
      tableName: 'rag-preference-profiles',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
    // 6. Shared env vars for RAG Lambdas
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

    // --- rag-ingest-lambda ---
    const ragIngestLambda = createRagLambda('RagIngestLambda', 'cmd/rag-ingest-lambda', 'ragingest-latest', {
      description: 'RAG ingest — consumes ContentFeedback from SQS, embeds via Bedrock, upserts to Aurora',
      memorySize: 1024,
      timeout: cdk.Duration.minutes(2),
      environment: {
        BEDROCK_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
      },
    });
    ragIngestLambda.addEventSource(new lambdaEventSources.SqsEventSource(ingestQueue));

    // --- rag-query-lambda ---
    this.ragQueryLambda = createRagLambda('RagQueryLambda', 'cmd/rag-query-lambda', 'ragquery-latest', {
      description: 'RAG query — retrieves similar decisions for triage/selection/description',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
    });

    // --- rag-status-lambda ---
    const ragStatusLambda = createRagLambda('RagStatusLambda', 'cmd/rag-status-lambda', 'ragstatus-latest', {
      description: 'RAG status — checks Aurora state, starts if stopped (frontend health check)',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
    });

    // --- rag-autostop-lambda ---
    const ragAutostopLambda = createRagLambda('RagAutostopLambda', 'cmd/rag-autostop-lambda', 'ragautostop-latest', {
      description: 'RAG autostop — stops Aurora after 2h idle (runs every 15 min)',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
    });

    // --- rag-profile-lambda ---
    const ragProfileLambda = createRagLambda('RagProfileLambda', 'cmd/rag-profile-lambda', 'ragprofile-latest', {
      description: 'RAG profile — weekly batch: computes preference profile, writes to DynamoDB',
      memorySize: 2048,
      timeout: cdk.Duration.minutes(5),
      environment: {
        SSM_API_KEY_PARAM: '/ai-social-media/prod/gemini-api-key',
      },
    });

    const ragLambdas = [
      ragIngestLambda,
      this.ragQueryLambda,
      ragStatusLambda,
      ragAutostopLambda,
      ragProfileLambda,
    ];

    // =========================================================================
    // 7. EventBridge Schedules
    // =========================================================================
    new events.Rule(this, 'RagAutostopSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(ragAutostopLambda)],
    });

    new events.Rule(this, 'RagProfileSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.days(7)),
      targets: [new targets.LambdaFunction(ragProfileLambda)],
    });

    // =========================================================================
    // 8. API Gateway route — GET /api/rag/status (no auth)
    // =========================================================================
    // Use HttpRoute with RAG stack as scope to avoid circular dependency (route in Backend would reference RAG Lambda).
    const statusIntegration = new integrations.HttpLambdaIntegration(
      'RagStatusIntegration',
      ragStatusLambda,
    );
    new apigwv2.HttpRoute(this, 'RagStatusRoute', {
      httpApi: props.httpApi,
      routeKey: apigwv2.HttpRouteKey.with('/api/rag/status', apigwv2.HttpMethod.GET),
      integration: statusIntegration,
    });

    // =========================================================================
    // 9. IAM Permissions
    // =========================================================================
    for (const fn of ragLambdas) {
      auroraCluster.grantDataApiAccess(fn);
      auroraSecret.grantRead(fn);
      this.ragProfilesTable.grantReadWriteData(fn);
    }

    ragIngestLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );

    ragStatusLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:DescribeDBClusters', 'rds:StartDBCluster'],
        resources: [auroraCluster.clusterArn],
      }),
    );

    ragAutostopLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds:DescribeDBClusters', 'rds:StopDBCluster'],
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
    ragProfileLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );

    // =========================================================================
    // 10. Cross-stack wiring — existing Lambdas
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
    // Use resource-based policy on RAG lambda (not grantInvoke) to avoid circular dependency:
    // grantInvoke would add a policy to Backend's lambdas referencing RAG's ARN.
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
  }
}
