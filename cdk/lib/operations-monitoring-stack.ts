import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';

import { NamedLambda } from './operations-alert-stack.js';

export interface OperationsMonitoringStackProps extends cdk.StackProps {
  /** All Lambda functions to monitor, with stable names for construct IDs */
  lambdas: NamedLambda[];
  /** API Gateway HTTP API */
  httpApi: apigwv2.HttpApi;
  /** Step Functions state machines */
  selectionPipeline: sfn.StateMachine;
  enhancementPipeline: sfn.StateMachine;
  /** DynamoDB sessions table */
  sessionsTable: dynamodb.ITable;
  /** S3 media bucket */
  mediaBucket: s3.IBucket;
  /** Log archive S3 bucket (from StorageStack — DDR-045: stateful/stateless split) */
  logArchiveBucket: s3.IBucket;
  /** Metrics archive S3 bucket (from StorageStack — DDR-045: optional, stateful/stateless split) */
  metricsArchiveBucket?: s3.IBucket;
  /** All alarms from OperationsAlertStack (for dashboard alarm status widget) */
  alarms: cloudwatch.Alarm[];
}

/**
 * OperationsMonitoringStack provides dashboards, metric filters, log archival,
 * and Glue tables (DDR-047: split from OperationsStack).
 *
 * Components:
 * - 2 Firehose delivery streams (INFO+ and DEBUG logs -> S3)
 * - 30 metric filters (6 per Lambda × 5 Lambdas)
 * - 10 subscription filters (2 per Lambda for Firehose archival)
 * - Glue database + table for Athena querying
 * - ~45-widget CloudWatch dashboard
 * - Metric Streams -> Firehose -> S3 for long-term metric archival (DDR-047)
 *
 * This stack changes rarely and is slower to deploy (~5 min).
 * See also: OperationsAlertStack for alarms, SNS, and X-Ray.
 */
export class OperationsMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OperationsMonitoringStackProps) {
    super(scope, id, props);

    const lambdas = props.lambdas;

    // Log archive bucket from StorageStack (DDR-045: stateful/stateless split)
    const logArchiveBucket = props.logArchiveBucket;

    // =========================================================================
    // Firehose Delivery Streams for Log Archival
    // =========================================================================
    // IAM role for Firehose to write to S3
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    logArchiveBucket.grantReadWrite(firehoseRole);

    // Firehose for INFO+ logs
    const infoFirehose = new firehose.CfnDeliveryStream(this, 'InfoFirehose', {
      deliveryStreamName: 'AiSocialMediaLogsInfo',
      s3DestinationConfiguration: {
        bucketArn: logArchiveBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: 'logs/info-and-above/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'logs/errors/',
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 5,
        },
        compressionFormat: 'GZIP',
      },
    });

    // Firehose for DEBUG logs
    const debugFirehose = new firehose.CfnDeliveryStream(this, 'DebugFirehose', {
      deliveryStreamName: 'AiSocialMediaLogsDebug',
      s3DestinationConfiguration: {
        bucketArn: logArchiveBucket.bucketArn,
        roleArn: firehoseRole.roleArn,
        prefix: 'logs/debug/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
        errorOutputPrefix: 'logs/errors/',
        bufferingHints: {
          intervalInSeconds: 60,
          sizeInMBs: 5,
        },
        compressionFormat: 'GZIP',
      },
    });

    // IAM role for CloudWatch Logs to write to Firehose
    const cwLogsToFirehoseRole = new iam.Role(this, 'CWLogsToFirehoseRole', {
      assumedBy: new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
    });
    const cwLogsPolicy = new iam.Policy(this, 'CWLogsToFirehosePolicy', {
      roles: [cwLogsToFirehoseRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
          resources: [infoFirehose.attrArn, debugFirehose.attrArn],
        }),
      ],
    });

    // =========================================================================
    // Log Groups: Subscription Filters + Metric Filters
    // =========================================================================
    const metricNamespace = 'AiSocialMedia/Logs';

    for (const { id, fn } of lambdas) {
      const logGroupName = `/aws/lambda/${fn.functionName}`;

      // Import the log group created by the BackendStack's Lambda construct.
      const logGroup = logs.LogGroup.fromLogGroupName(this, `LogGroup-${id}`, logGroupName);

      // Subscription filter 1: INFO+ logs (everything except debug)
      const infoFilter = new logs.CfnSubscriptionFilter(this, `InfoFilter-${id}`, {
        logGroupName: logGroup.logGroupName,
        filterName: `${id}-info-and-above`,
        filterPattern: '?INFO ?WARN ?ERROR ?FATAL ?REPORT ?START ?END ?info ?warn ?error ?fatal',
        destinationArn: infoFirehose.attrArn,
        roleArn: cwLogsToFirehoseRole.roleArn,
      });
      infoFilter.node.addDependency(cwLogsPolicy);

      // Subscription filter 2: DEBUG logs only
      const debugFilter = new logs.CfnSubscriptionFilter(this, `DebugFilter-${id}`, {
        logGroupName: logGroup.logGroupName,
        filterName: `${id}-debug`,
        filterPattern: '?DEBUG ?debug ?trace',
        destinationArn: debugFirehose.attrArn,
        roleArn: cwLogsToFirehoseRole.roleArn,
      });
      debugFilter.node.addDependency(cwLogsPolicy);

      // --- Metric Filters ---
      new logs.MetricFilter(this, `ErrorFilter-${id}`, {
        logGroup,
        filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'error'),
        metricNamespace,
        metricName: `AppLogErrors-${id}`,
        metricValue: '1',
        defaultValue: 0,
      });

      new logs.MetricFilter(this, `FatalFilter-${id}`, {
        logGroup,
        filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'fatal'),
        metricNamespace,
        metricName: `CriticalErrors-${id}`,
        metricValue: '1',
        defaultValue: 0,
      });

      new logs.MetricFilter(this, `RateLimitFilter-${id}`, {
        logGroup,
        filterPattern: logs.FilterPattern.anyTerm('rate limit', '429', 'quota', 'resource exhausted'),
        metricNamespace,
        metricName: 'RateLimitHits',
        metricValue: '1',
        defaultValue: 0,
      });

      new logs.MetricFilter(this, `TimeoutFilter-${id}`, {
        logGroup,
        filterPattern: logs.FilterPattern.anyTerm('timeout', 'deadline exceeded'),
        metricNamespace,
        metricName: 'TimeoutErrors',
        metricValue: '1',
        defaultValue: 0,
      });

      new logs.MetricFilter(this, `AuthFilter-${id}`, {
        logGroup,
        filterPattern: logs.FilterPattern.anyTerm('authentication failed', 'unauthorized', 'forbidden'),
        metricNamespace,
        metricName: 'AuthFailures',
        metricValue: '1',
        defaultValue: 0,
      });

      new logs.MetricFilter(this, `ColdStartFilter-${id}`, {
        logGroup,
        filterPattern: logs.FilterPattern.allTerms('REPORT', 'Init Duration'),
        metricNamespace,
        metricName: 'ColdStarts',
        metricValue: '1',
        defaultValue: 0,
      });
    }

    // =========================================================================
    // Glue Table for Athena Querying of Archived Logs
    // =========================================================================
    const glueDb = new glue.CfnDatabase(this, 'LogsDatabase', {
      catalogId: this.account,
      databaseInput: {
        name: 'ai_social_media_logs',
        description: 'Archived Lambda logs from CloudWatch via Firehose',
      },
    });

    new glue.CfnTable(this, 'LogsTable', {
      catalogId: this.account,
      databaseName: 'ai_social_media_logs',
      tableInput: {
        name: 'lambda_logs',
        description: 'Archived Lambda logs (GZIP compressed, date-partitioned)',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'classification': 'json',
          'compressionType': 'gzip',
        },
        storageDescriptor: {
          location: `s3://${logArchiveBucket.bucketName}/logs/info-and-above/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe',
          },
          columns: [
            { name: 'level', type: 'string' },
            { name: 'time', type: 'string' },
            { name: 'msg', type: 'string' },
            { name: 'error', type: 'string' },
            { name: 'caller', type: 'string' },
          ],
        },
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
      },
    });

    // Ensure table depends on database
    const tableNode = this.node.findChild('LogsTable');
    tableNode.node.addDependency(glueDb);

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
    // Long-Term Metric Storage: Metric Streams -> Firehose -> S3 (DDR-047)
    // Bucket is from StorageStack (DDR-045); Firehose/MetricStream stay here (stateless).
    // Enabled by default; disable with -c enableMetricArchive=false.
    // =========================================================================
    if (props.metricsArchiveBucket) {
      const metricsArchiveBucket = props.metricsArchiveBucket;

      const metricsFirehoseRole = new iam.Role(this, 'MetricsFirehoseRole', {
        assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
      });
      metricsArchiveBucket.grantReadWrite(metricsFirehoseRole);

      const metricsFirehose = new firehose.CfnDeliveryStream(this, 'MetricsFirehose', {
        deliveryStreamName: 'AiSocialMediaMetrics',
        s3DestinationConfiguration: {
          bucketArn: metricsArchiveBucket.bucketArn,
          roleArn: metricsFirehoseRole.roleArn,
          prefix: 'metrics/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/',
          errorOutputPrefix: 'metrics/errors/',
          bufferingHints: {
            intervalInSeconds: 60,
            sizeInMBs: 5,
          },
          compressionFormat: 'GZIP',
        },
      });

      const metricStreamRole = new iam.Role(this, 'MetricStreamRole', {
        assumedBy: new iam.ServicePrincipal('streams.metrics.cloudwatch.amazonaws.com'),
      });
      metricStreamRole.addToPolicy(new iam.PolicyStatement({
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: [metricsFirehose.attrArn],
      }));

      new cloudwatch.CfnMetricStream(this, 'MetricStream', {
        name: 'AiSocialMediaMetricStream',
        firehoseArn: metricsFirehose.attrArn,
        roleArn: metricStreamRole.roleArn,
        outputFormat: 'json',
        includeFilters: [
          { namespace: 'AWS/Lambda' },
          { namespace: 'AWS/ApiGateway' },
          { namespace: 'AWS/States' },
          { namespace: 'AWS/DynamoDB' },
          { namespace: 'AiSocialMedia' },
          { namespace: 'AiSocialMedia/Logs' },
        ],
      });
    }

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=AiSocialMediaDashboard`,
      description: 'CloudWatch Dashboard URL',
    });
  }
}
