import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { NamedLambda } from './operations-alert-stack.js';

export interface OperationsDashboardStackProps extends cdk.StackProps {
  /** All Lambda functions to monitor, with stable names for construct IDs */
  lambdas: NamedLambda[];
  /** API Gateway HTTP API */
  httpApi: apigwv2.HttpApi;
  /** Step Functions state machines */
  selectionPipeline: sfn.StateMachine;
  enhancementPipeline: sfn.StateMachine;
  triagePipeline: sfn.StateMachine;
  publishPipeline: sfn.StateMachine;
  /** DynamoDB sessions table */
  sessionsTable: dynamodb.ITable;
  /** DynamoDB file processing table (DDR-061) */
  fileProcessingTable: dynamodb.ITable;
  /** S3 media bucket */
  mediaBucket: s3.IBucket;
  /** All alarms from OperationsAlertStack (for dashboard alarm status widget) */
  alarms: cloudwatch.Alarm[];
}

/**
 * OperationsDashboardStack provides the CloudWatch dashboard (~45 widgets).
 * Split from OperationsMonitoringStack (DDR-054: deploy speed Phase 5) so
 * dashboard-only changes deploy in seconds instead of ~90s.
 *
 * See also: OperationsLogIngestionStack for metric filters, subscription
 * filters, Firehose, Glue, and metric streams.
 */
export class OperationsDashboardStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OperationsDashboardStackProps) {
    super(scope, id, props);

    const lambdas = props.lambdas;
    const metricNamespace = 'AiSocialMedia/Logs';

    // =========================================================================
    // CloudWatch Dashboard (~45 widgets)
    // =========================================================================
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'AiSocialMediaDashboard',
      defaultInterval: cdk.Duration.hours(6),
    });

    const period = cdk.Duration.minutes(5);
    const apiId = props.httpApi.apiId;

    // Helper: create an API Gateway metric
    const apiGwMetric = (name: string, stat: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: name,
        dimensionsMap: { ApiId: apiId },
        statistic: stat,
        period,
      });

    // Helper: create a custom EMF metric
    const emfMetric = (name: string, stat: string, dims?: Record<string, string>) =>
      new cloudwatch.Metric({
        namespace: 'AiSocialMedia',
        metricName: name,
        dimensionsMap: dims,
        statistic: stat,
        period,
      });

    // Helper: create a log metric filter metric
    const logMetric = (name: string, fnName?: string) =>
      new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: name,
        dimensionsMap: fnName ? { FunctionName: fnName } : undefined,
        statistic: 'Sum',
        period,
      });

    // --- Row 1: Service Health Overview ---
    dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarm Status',
        alarms: props.alarms,
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'API Requests (5 min)',
        metrics: [apiGwMetric('Count', 'Sum')],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: '5XX Errors',
        metrics: [apiGwMetric('5xx', 'Sum')],
        width: 6,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: '4XX Errors',
        metrics: [apiGwMetric('4xx', 'Sum')],
        width: 6,
        height: 4,
      }),
    );

    // --- Row 2: API Gateway ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Request Volume',
        left: [apiGwMetric('Count', 'Sum')],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Error Rates',
        left: [apiGwMetric('4xx', 'Sum'), apiGwMetric('5xx', 'Sum')],
        stacked: true,
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Latency Percentiles',
        left: [
          apiGwMetric('Latency', 'p50'),
          apiGwMetric('Latency', 'p90'),
          apiGwMetric('Latency', 'p99'),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Integration Latency',
        left: [
          apiGwMetric('IntegrationLatency', 'p50'),
          apiGwMetric('IntegrationLatency', 'p90'),
          apiGwMetric('IntegrationLatency', 'p99'),
        ],
        width: 6,
        height: 6,
      }),
    );

    // --- Row 3: Lambda - API Handler ---
    const apiFn = lambdas[0].fn;
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Handler: Invocations & Errors',
        left: [
          apiFn.metricInvocations({ period }),
          apiFn.metricErrors({ period }),
          apiFn.metricThrottles({ period }),
        ],
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Handler: Duration',
        left: [
          apiFn.metricDuration({ period, statistic: 'p50' }),
          apiFn.metricDuration({ period, statistic: 'p90' }),
          apiFn.metricDuration({ period, statistic: 'p99' }),
          apiFn.metricDuration({ period, statistic: 'Maximum' }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Handler: Concurrent Executions',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'ConcurrentExecutions',
          dimensionsMap: { FunctionName: apiFn.functionName },
          statistic: 'Maximum',
          period,
        })],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 4: Lambda - Processing Functions ---
    const processingFns = [
      { fn: lambdas[1].fn, label: 'Thumbnail' },
      { fn: lambdas[2].fn, label: 'Selection' },
      { fn: lambdas[3].fn, label: 'Enhancement' },
      { fn: lambdas[4].fn, label: 'Video' },
    ];

    for (const { fn, label } of processingFns) {
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${label}: Invocations/Errors + Duration`,
          left: [fn.metricInvocations({ period }), fn.metricErrors({ period })],
          right: [fn.metricDuration({ period, statistic: 'p99' })],
          width: 6,
          height: 6,
        }),
      );
    }

    // --- Row 5: All Lambda Cross-Comparison ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'All Lambda Errors',
        left: lambdas.map(({ fn }) => fn.metricErrors({ period })),
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'All Lambda Duration p99',
        left: lambdas.map(({ fn }) => fn.metricDuration({ period, statistic: 'p99' })),
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'All Lambda Throttles',
        left: lambdas.map(({ fn }) => fn.metricThrottles({ period })),
        stacked: true,
        width: 8,
        height: 6,
      }),
    );

    // --- Row 6: Step Functions - Selection Pipeline ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Selection Pipeline: Executions',
        left: [
          props.selectionPipeline.metricStarted({ period }),
          props.selectionPipeline.metricSucceeded({ period }),
          props.selectionPipeline.metricFailed({ period }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Selection Pipeline: Execution Time',
        left: [
          props.selectionPipeline.metricTime({ period, statistic: 'p50' }),
          props.selectionPipeline.metricTime({ period, statistic: 'p90' }),
          props.selectionPipeline.metricTime({ period, statistic: 'p99' }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Selection Pipeline: Failures & Timeouts',
        left: [
          props.selectionPipeline.metricFailed({ period }),
          props.selectionPipeline.metricTimedOut({ period }),
          props.selectionPipeline.metricAborted({ period }),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 7: Step Functions - Enhancement Pipeline ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Enhancement Pipeline: Executions',
        left: [
          props.enhancementPipeline.metricStarted({ period }),
          props.enhancementPipeline.metricSucceeded({ period }),
          props.enhancementPipeline.metricFailed({ period }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Enhancement Pipeline: Execution Time',
        left: [
          props.enhancementPipeline.metricTime({ period, statistic: 'p50' }),
          props.enhancementPipeline.metricTime({ period, statistic: 'p90' }),
          props.enhancementPipeline.metricTime({ period, statistic: 'p99' }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Enhancement Pipeline: Failures & Timeouts',
        left: [
          props.enhancementPipeline.metricFailed({ period }),
          props.enhancementPipeline.metricTimedOut({ period }),
          props.enhancementPipeline.metricAborted({ period }),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 7b: Step Functions - Triage Pipeline (DDR-061) ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Triage Pipeline: Executions',
        left: [
          props.triagePipeline.metricStarted({ period }),
          props.triagePipeline.metricSucceeded({ period }),
          props.triagePipeline.metricFailed({ period }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Triage Pipeline: Execution Time',
        left: [
          props.triagePipeline.metricTime({ period, statistic: 'p50' }),
          props.triagePipeline.metricTime({ period, statistic: 'p90' }),
          props.triagePipeline.metricTime({ period, statistic: 'p99' }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Triage Pipeline: Failures & Timeouts',
        left: [
          props.triagePipeline.metricFailed({ period }),
          props.triagePipeline.metricTimedOut({ period }),
          props.triagePipeline.metricAborted({ period }),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 8: Gemini API (EMF custom metrics) ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Gemini API Calls by Operation',
        left: [
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'triage' }),
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'mediaSelection' }),
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'jsonSelection' }),
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'filesApiUpload' }),
        ],
        stacked: true,
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini API Latency (p99)',
        left: [
          emfMetric('GeminiApiLatencyMs', 'p99', { Operation: 'triage' }),
          emfMetric('GeminiApiLatencyMs', 'p99', { Operation: 'mediaSelection' }),
          emfMetric('GeminiApiLatencyMs', 'p99', { Operation: 'jsonSelection' }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Token Usage',
        left: [emfMetric('GeminiInputTokens', 'Sum')],
        right: [emfMetric('GeminiOutputTokens', 'Sum')],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Errors & Rate Limits',
        left: [
          emfMetric('GeminiApiErrors', 'Sum'),
          logMetric('RateLimitHits'),
        ],
        width: 6,
        height: 6,
      }),
    );

    // --- Row 9: Media Processing (EMF custom metrics) ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Request Count by Endpoint',
        left: [
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/triage/start' }),
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/selection/start' }),
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/enhance/start' }),
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/upload-url' }),
        ],
        stacked: true,
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Request Latency by Endpoint (p99)',
        left: [
          emfMetric('RequestLatencyMs', 'p99', { Endpoint: '/api/triage/start' }),
          emfMetric('RequestLatencyMs', 'p99', { Endpoint: '/api/selection/start' }),
          emfMetric('RequestLatencyMs', 'p99', { Endpoint: '/api/upload-url' }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Video Compression Duration',
        left: [
          emfMetric('VideoCompressionMs', 'p50'),
          emfMetric('VideoCompressionMs', 'p99'),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Job Duration by Type',
        left: [
          emfMetric('JobDurationMs', 'p50', { JobType: 'triage' }),
          emfMetric('JobDurationMs', 'p99', { JobType: 'triage' }),
        ],
        width: 6,
        height: 6,
      }),
    );

    // --- Row 9b: MediaProcess Lambda (DDR-061) ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: Files Processed',
        left: [
          emfMetric('FilesProcessed', 'Sum', { Operation: 'mediaProcess' }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: Processing Duration',
        left: [
          emfMetric('FileProcessingMs', 'p50', { Operation: 'mediaProcess' }),
          emfMetric('FileProcessingMs', 'p99', { Operation: 'mediaProcess' }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: File Sizes',
        left: [
          emfMetric('FileSize', 'Average', { Operation: 'mediaProcess' }),
          emfMetric('FileSize', 'Maximum', { Operation: 'mediaProcess' }),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: By File Type',
        left: [
          emfMetric('FilesProcessed', 'Sum', { FileType: 'image' }),
          emfMetric('FilesProcessed', 'Sum', { FileType: 'video' }),
        ],
        stacked: true,
        width: 6,
        height: 6,
      }),
    );

    // --- Row 10: DynamoDB ---
    const dynamoMetric = (name: string, stat: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: name,
        dimensionsMap: { TableName: props.sessionsTable.tableName },
        statistic: stat,
        period,
      });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Consumed Capacity',
        left: [dynamoMetric('ConsumedReadCapacityUnits', 'Sum')],
        right: [dynamoMetric('ConsumedWriteCapacityUnits', 'Sum')],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Latency',
        left: [dynamoMetric('SuccessfulRequestLatency', 'Average')],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Errors',
        left: [
          dynamoMetric('ThrottledRequests', 'Sum'),
          dynamoMetric('UserErrors', 'Sum'),
          dynamoMetric('SystemErrors', 'Sum'),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 10b: File Processing Table (DDR-061) ---
    const fpDynamoMetric = (name: string, stat: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: name,
        dimensionsMap: { TableName: props.fileProcessingTable.tableName },
        statistic: stat,
        period,
      });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'File Processing Table: Capacity',
        left: [fpDynamoMetric('ConsumedReadCapacityUnits', 'Sum')],
        right: [fpDynamoMetric('ConsumedWriteCapacityUnits', 'Sum')],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'File Processing Table: Latency',
        left: [fpDynamoMetric('SuccessfulRequestLatency', 'Average')],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'File Processing Table: Errors',
        left: [
          fpDynamoMetric('ThrottledRequests', 'Sum'),
          fpDynamoMetric('UserErrors', 'Sum'),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 11: S3 ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'S3 Bucket Size',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/S3',
          metricName: 'BucketSizeBytes',
          dimensionsMap: {
            BucketName: props.mediaBucket.bucketName,
            StorageType: 'StandardStorage',
          },
          statistic: 'Average',
          period: cdk.Duration.days(1),
        })],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'S3 Object Count',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/S3',
          metricName: 'NumberOfObjects',
          dimensionsMap: {
            BucketName: props.mediaBucket.bucketName,
            StorageType: 'AllStorageTypes',
          },
          statistic: 'Average',
          period: cdk.Duration.days(1),
        })],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'S3 Operations (EMF)',
        left: [
          emfMetric('MediaFileSizeBytes', 'Sum'),
          emfMetric('GeminiFilesApiUploadBytes', 'Sum'),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 12: Application Log Metrics ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'App Errors from Logs',
        left: lambdas.map(({ id }) => logMetric(`AppLogErrors-${id}`)),
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Rate Limits & Timeouts',
        left: [logMetric('RateLimitHits'), logMetric('TimeoutErrors')],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Cold Starts (all functions)',
        left: [logMetric('ColdStarts')],
        width: 8,
        height: 6,
      }),
    );

    // --- Row 13: Auth & Validation (EMF) ---
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Key Validation Latency',
        left: [
          emfMetric('ApiKeyValidationMs', 'p50', { Result: 'success' }),
          emfMetric('ApiKeyValidationMs', 'p99', { Result: 'success' }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Key Validation Results',
        left: [
          emfMetric('ApiKeyValidationResult', 'Sum', { Result: 'success' }),
          emfMetric('ApiKeyValidationResult', 'Sum', { Result: 'invalid' }),
          emfMetric('ApiKeyValidationResult', 'Sum', { Result: 'quota' }),
          emfMetric('ApiKeyValidationResult', 'Sum', { Result: 'network_error' }),
        ],
        stacked: true,
        width: 12,
        height: 6,
      }),
    );

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=AiSocialMediaDashboard`,
      description: 'CloudWatch Dashboard URL',
    });
  }
}
