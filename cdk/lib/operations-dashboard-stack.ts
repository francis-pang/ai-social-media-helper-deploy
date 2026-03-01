import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
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
  /** CloudFront distribution (for standard + additional metrics) */
  distribution: cloudfront.IDistribution;
  /** All alarms from OperationsAlertStack (for dashboard alarm status widget) */
  alarms: cloudwatch.Alarm[];
}

/**
 * OperationsDashboardStack provides three purpose-built CloudWatch dashboards (DDR-075):
 *   - AiSocialMedia-Triage       (active triage workflow)
 *   - AiSocialMedia-Selection    (selection/enhancement/publish)
 *   - AiSocialMedia-Infrastructure (common infra)
 *
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
    const period = cdk.Duration.minutes(5);
    const apiId = props.httpApi.apiId;

    // Resolve specific Lambda functions by stable ID
    const getLambda = (lambdaId: string) => lambdas.find((l) => l.id === lambdaId)!.fn;
    const apiHandlerFn = getLambda('ApiHandler');
    const triageProcessorFn = getLambda('TriageProcessor');
    const selectionProcessorFn = getLambda('SelectionProcessor');
    const enhancementProcessorFn = getLambda('EnhancementProcessor');
    const videoProcessorFn = getLambda('VideoProcessor');
    const thumbnailProcessorFn = getLambda('ThumbnailProcessor');
    const publishProcessorFn = getLambda('PublishProcessor');
    const mediaProcessFn = getLambda('MediaProcessProcessor');

    // -------------------------------------------------------------------------
    // Shared metric helpers
    // -------------------------------------------------------------------------

    // Custom EMF metrics (namespace: AiSocialMedia, no FunctionName — DDR-075 fix)
    const emfMetric = (name: string, stat: string, dims?: Record<string, string>) =>
      new cloudwatch.Metric({
        namespace: 'AiSocialMedia',
        metricName: name,
        dimensionsMap: dims,
        statistic: stat,
        period,
      });

    // Log metric filter metrics
    const logMetric = (name: string) =>
      new cloudwatch.Metric({
        namespace: metricNamespace,
        metricName: name,
        statistic: 'Sum',
        period,
      });

    // API Gateway metrics
    const apiGwMetric = (name: string, stat: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: name,
        dimensionsMap: { ApiId: apiId },
        statistic: stat,
        period,
      });

    // CloudFront metrics
    const cfMetric = (name: string, stat: string) =>
      new cloudwatch.Metric({
        namespace: 'AWS/CloudFront',
        metricName: name,
        dimensionsMap: {
          DistributionId: props.distribution.distributionId,
          Region: 'Global',
        },
        statistic: stat,
        period,
      });

    // DynamoDB metric helper — includes optional Operation dimension (DDR-075: exact dim match)
    const makeDynamoMetric =
      (table: dynamodb.ITable) =>
      (name: string, stat: string, operation?: string): cloudwatch.IMetric => {
        const dims: Record<string, string> = { TableName: table.tableName };
        if (operation) dims['Operation'] = operation;
        return new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: name,
          dimensionsMap: dims,
          statistic: stat,
          period,
        });
      };

    // Auto-incrementing ID counter — CDK requires unique metric IDs within each graph widget.
    // MathExpression.usingMetrics keys must be unique per widget; a global counter avoids collisions.
    let _metricId = 0;
    const nextId = () => `m${++_metricId}`;

    // ms → s conversion for metrics typically > 1 second (SFN execution time, job durations)
    const msToSeconds = (m: cloudwatch.IMetric, label: string): cloudwatch.IMetric => {
      const id = nextId();
      return new cloudwatch.MathExpression({
        expression: `${id} / 1000`,
        usingMetrics: { [id]: m },
        label,
        period,
      });
    };

    // FILL(m, 0) — show zero during idle periods rather than "no data" gaps
    const fillZero = (m: cloudwatch.IMetric, label: string): cloudwatch.IMetric => {
      const id = nextId();
      return new cloudwatch.MathExpression({
        expression: `FILL(${id}, 0)`,
        usingMetrics: { [id]: m },
        label,
        period,
      });
    };

    // =========================================================================
    // Dashboard 1: AiSocialMedia-Triage
    // Active triage workflow — all metrics expected to have data.
    // =========================================================================
    const triageDash = new cloudwatch.Dashboard(this, 'TriageDashboard', {
      dashboardName: 'AiSocialMedia-Triage',
      defaultInterval: cdk.Duration.hours(6),
    });

    // --- Triage Row 1: Triage Pipeline (SFN) ---
    triageDash.addWidgets(
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
          msToSeconds(props.triagePipeline.metricTime({ period, statistic: 'p50' }), 'p50'),
          msToSeconds(props.triagePipeline.metricTime({ period, statistic: 'p90' }), 'p90'),
          msToSeconds(props.triagePipeline.metricTime({ period, statistic: 'p99' }), 'p99'),
        ],
        leftYAxis: { label: 's' },
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

    // --- Triage Row 2: MediaProcess Lambda ---
    triageDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: Invocations & Errors',
        left: [
          mediaProcessFn.metricInvocations({ period }),
          mediaProcessFn.metricErrors({ period }),
          mediaProcessFn.metricThrottles({ period }),
        ],
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: Duration',
        left: [
          mediaProcessFn.metricDuration({ period, statistic: 'p50' }),
          mediaProcessFn.metricDuration({ period, statistic: 'p90' }),
          mediaProcessFn.metricDuration({ period, statistic: 'p99' }),
          mediaProcessFn.metricDuration({ period, statistic: 'Maximum' }),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: Concurrent Executions',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'ConcurrentExecutions',
          dimensionsMap: { FunctionName: mediaProcessFn.functionName },
          statistic: 'Maximum',
          period,
        })],
        width: 8,
        height: 6,
      }),
    );

    // --- Triage Row 3: File Processing (EMF) ---
    triageDash.addWidgets(
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
        leftYAxis: { label: 'ms' },
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'MediaProcess: File Sizes',
        left: [
          emfMetric('FileSize', 'Average', { Operation: 'mediaProcess' }),
          emfMetric('FileSize', 'Maximum', { Operation: 'mediaProcess' }),
        ],
        leftYAxis: { label: 'Bytes' },
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

    // --- Triage Row 4: Video & Image Processing (EMF) ---
    triageDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Video Compression Duration',
        left: [
          emfMetric('VideoCompressionMs', 'p50'),
          emfMetric('VideoCompressionMs', 'p99'),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Image Resize Duration',
        left: [
          emfMetric('ImageResizeMs', 'p50'),
          emfMetric('ImageResizeMs', 'p99'),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Image Size After Resize',
        left: [
          emfMetric('ImageSizeBytes', 'Average'),
          emfMetric('ImageSizeBytes', 'Maximum'),
        ],
        leftYAxis: { label: 'Bytes' },
        width: 8,
        height: 6,
      }),
    );

    // --- Triage Row 5: Gemini API — Triage ---
    triageDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Gemini Triage: API Calls',
        left: [
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'triage' }),
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'filesApiUpload' }),
        ],
        stacked: true,
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Triage: API Latency',
        left: [
          emfMetric('GeminiApiLatencyMs', 'p50', { Operation: 'triage' }),
          emfMetric('GeminiApiLatencyMs', 'p99', { Operation: 'triage' }),
        ],
        leftYAxis: { label: 'ms' },
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Triage: Token Usage',
        left: [emfMetric('GeminiInputTokens', 'Sum', { Operation: 'triage' })],
        right: [emfMetric('GeminiOutputTokens', 'Sum', { Operation: 'triage' })],
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

    // --- Triage Row 6: Triage Processor Lambda + Job EMF ---
    triageDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'TriageProcessor: Invocations & Errors',
        left: [
          triageProcessorFn.metricInvocations({ period }),
          triageProcessorFn.metricErrors({ period }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'TriageProcessor: Duration',
        left: [
          triageProcessorFn.metricDuration({ period, statistic: 'p50' }),
          triageProcessorFn.metricDuration({ period, statistic: 'p99' }),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Triage Job Duration',
        left: [
          msToSeconds(emfMetric('JobDurationMs', 'p50', { JobType: 'triage' }), 'p50'),
          msToSeconds(emfMetric('JobDurationMs', 'p99', { JobType: 'triage' }), 'p99'),
        ],
        leftYAxis: { label: 's' },
        width: 8,
        height: 6,
      }),
    );

    // --- Triage Row 7: File Processing Table (DDR-061) with Operation dimension ---
    const fpDynamo = makeDynamoMetric(props.fileProcessingTable);
    triageDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'File Processing Table: Capacity',
        left: [
          fillZero(fpDynamo('ConsumedReadCapacityUnits', 'Sum'), 'Read CU'),
          fillZero(fpDynamo('ConsumedWriteCapacityUnits', 'Sum'), 'Write CU'),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'File Processing Table: Latency',
        left: [
          fpDynamo('SuccessfulRequestLatency', 'Average', 'GetItem'),
          fpDynamo('SuccessfulRequestLatency', 'Average', 'PutItem'),
          fpDynamo('SuccessfulRequestLatency', 'Average', 'UpdateItem'),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'File Processing Table: Errors',
        left: [
          fpDynamo('ThrottledRequests', 'Sum'),
          fpDynamo('UserErrors', 'Sum'),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Triage Row 8: Request Metrics (triage endpoints) ---
    triageDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Request Count by Endpoint',
        left: [
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/triage/start' }),
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/upload-url' }),
        ],
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Request Latency by Endpoint (p99)',
        left: [
          emfMetric('RequestLatencyMs', 'p99', { Endpoint: '/api/triage/start' }),
          emfMetric('RequestLatencyMs', 'p99', { Endpoint: '/api/upload-url' }),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Triage Job Files',
        left: [
          emfMetric('TriageJobFiles', 'Sum'),
          emfMetric('TriageJobFiles', 'Average'),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Triage Row 9: S3 Data Flow ---
    triageDash.addWidgets(
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
        leftYAxis: { label: 'Bytes' },
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
        title: 'S3 Media Flow (EMF)',
        left: [
          emfMetric('MediaFileSizeBytes', 'Sum'),
          emfMetric('GeminiFilesApiUploadBytes', 'Sum'),
        ],
        leftYAxis: { label: 'Bytes' },
        width: 8,
        height: 6,
      }),
    );

    // =========================================================================
    // Dashboard 2: AiSocialMedia-Selection
    // Selection/enhancement/publish — expected to be empty until those workflows run.
    // =========================================================================
    const selectionDash = new cloudwatch.Dashboard(this, 'SelectionDashboard', {
      dashboardName: 'AiSocialMedia-Selection',
      defaultInterval: cdk.Duration.hours(6),
    });

    // --- Selection Row 1: Selection Pipeline (SFN) ---
    selectionDash.addWidgets(
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
          msToSeconds(props.selectionPipeline.metricTime({ period, statistic: 'p50' }), 'p50'),
          msToSeconds(props.selectionPipeline.metricTime({ period, statistic: 'p90' }), 'p90'),
          msToSeconds(props.selectionPipeline.metricTime({ period, statistic: 'p99' }), 'p99'),
        ],
        leftYAxis: { label: 's' },
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

    // --- Selection Row 2: Enhancement Pipeline (SFN) ---
    selectionDash.addWidgets(
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
          msToSeconds(props.enhancementPipeline.metricTime({ period, statistic: 'p50' }), 'p50'),
          msToSeconds(props.enhancementPipeline.metricTime({ period, statistic: 'p90' }), 'p90'),
          msToSeconds(props.enhancementPipeline.metricTime({ period, statistic: 'p99' }), 'p99'),
        ],
        leftYAxis: { label: 's' },
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

    // --- Selection Row 3: Publish Pipeline (SFN) ---
    selectionDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Publish Pipeline: Executions',
        left: [
          props.publishPipeline.metricStarted({ period }),
          props.publishPipeline.metricSucceeded({ period }),
          props.publishPipeline.metricFailed({ period }),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Publish Pipeline: Execution Time',
        left: [
          msToSeconds(props.publishPipeline.metricTime({ period, statistic: 'p50' }), 'p50'),
          msToSeconds(props.publishPipeline.metricTime({ period, statistic: 'p90' }), 'p90'),
          msToSeconds(props.publishPipeline.metricTime({ period, statistic: 'p99' }), 'p99'),
        ],
        leftYAxis: { label: 's' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Publish Pipeline: Failures & Timeouts',
        left: [
          props.publishPipeline.metricFailed({ period }),
          props.publishPipeline.metricTimedOut({ period }),
          props.publishPipeline.metricAborted({ period }),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Selection Row 4: Selection & Enhancement Lambdas ---
    selectionDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SelectionProcessor: Invocations & Errors',
        left: [
          selectionProcessorFn.metricInvocations({ period }),
          selectionProcessorFn.metricErrors({ period }),
        ],
        right: [selectionProcessorFn.metricDuration({ period, statistic: 'p99' })],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'EnhancementProcessor: Invocations & Errors',
        left: [
          enhancementProcessorFn.metricInvocations({ period }),
          enhancementProcessorFn.metricErrors({ period }),
        ],
        right: [enhancementProcessorFn.metricDuration({ period, statistic: 'p99' })],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'PublishProcessor: Invocations & Errors',
        left: [
          publishProcessorFn.metricInvocations({ period }),
          publishProcessorFn.metricErrors({ period }),
        ],
        right: [publishProcessorFn.metricDuration({ period, statistic: 'p99' })],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'ThumbnailProcessor: Invocations & Errors',
        left: [
          thumbnailProcessorFn.metricInvocations({ period }),
          thumbnailProcessorFn.metricErrors({ period }),
        ],
        right: [thumbnailProcessorFn.metricDuration({ period, statistic: 'p99' })],
        width: 6,
        height: 6,
      }),
    );

    // --- Selection Row 5: Gemini — Selection & JSON Selection ---
    selectionDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Gemini Selection: API Calls',
        left: [
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'mediaSelection' }),
          emfMetric('GeminiApiCalls', 'Sum', { Operation: 'jsonSelection' }),
        ],
        stacked: true,
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Selection: API Latency',
        left: [
          emfMetric('GeminiApiLatencyMs', 'p50', { Operation: 'mediaSelection' }),
          emfMetric('GeminiApiLatencyMs', 'p99', { Operation: 'mediaSelection' }),
          emfMetric('GeminiApiLatencyMs', 'p50', { Operation: 'jsonSelection' }),
          emfMetric('GeminiApiLatencyMs', 'p99', { Operation: 'jsonSelection' }),
        ],
        leftYAxis: { label: 'ms' },
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Selection: Token Usage',
        left: [emfMetric('GeminiInputTokens', 'Sum', { Operation: 'mediaSelection' })],
        right: [emfMetric('GeminiOutputTokens', 'Sum', { Operation: 'mediaSelection' })],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Publish Attempts',
        left: [
          emfMetric('PublishAttempts', 'Sum'),
          emfMetric('GeminiApiErrors', 'Sum', { Operation: 'jsonSelection' }),
        ],
        width: 6,
        height: 6,
      }),
    );

    // --- Selection Row 6: Gemini Cache & Files API ---
    selectionDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Gemini Cache Hits vs Misses',
        left: [
          emfMetric('GeminiCacheHits', 'Sum'),
          emfMetric('GeminiCacheMisses', 'Sum'),
        ],
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Cache Tokens Saved',
        left: [emfMetric('GeminiCacheTokensSaved', 'Sum')],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Gemini Files API Upload Bytes',
        left: [emfMetric('GeminiFilesApiUploadBytes', 'Sum')],
        leftYAxis: { label: 'Bytes' },
        width: 8,
        height: 6,
      }),
    );

    // --- Selection Row 7: Selection Request Metrics ---
    selectionDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Request Count by Endpoint',
        left: [
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/selection/start' }),
          emfMetric('RequestCount', 'Sum', { Endpoint: '/api/enhance/start' }),
        ],
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Request Latency by Endpoint (p99)',
        left: [
          emfMetric('RequestLatencyMs', 'p99', { Endpoint: '/api/selection/start' }),
          emfMetric('RequestLatencyMs', 'p99', { Endpoint: '/api/enhance/start' }),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Selection Job Duration',
        left: [
          msToSeconds(emfMetric('JobDurationMs', 'p50', { JobType: 'selection' }), 'p50'),
          msToSeconds(emfMetric('JobDurationMs', 'p99', { JobType: 'selection' }), 'p99'),
        ],
        leftYAxis: { label: 's' },
        width: 8,
        height: 6,
      }),
    );

    // =========================================================================
    // Dashboard 3: AiSocialMedia-Infrastructure
    // Common infrastructure metrics — API GW, CloudFront, Lambda, DynamoDB, S3, logs.
    // =========================================================================
    const infraDash = new cloudwatch.Dashboard(this, 'InfraDashboard', {
      dashboardName: 'AiSocialMedia-Infrastructure',
      defaultInterval: cdk.Duration.hours(6),
    });

    // --- Infra Row 1: Service Health Overview ---
    infraDash.addWidgets(
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

    // --- Infra Row 2: CloudFront ---
    infraDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'CloudFront Requests',
        left: [cfMetric('Requests', 'Sum')],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'CloudFront Error Rates',
        left: [
          cfMetric('4xxErrorRate', 'Average'),
          cfMetric('5xxErrorRate', 'Average'),
          cfMetric('503ErrorRate', 'Average'),
          cfMetric('504ErrorRate', 'Average'),
        ],
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'CloudFront Origin Latency',
        left: [
          cfMetric('OriginLatency', 'p50'),
          cfMetric('OriginLatency', 'p90'),
          cfMetric('OriginLatency', 'p99'),
        ],
        leftYAxis: { label: 'ms' },
        width: 6,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'CloudFront Data Transfer',
        left: [cfMetric('BytesDownloaded', 'Sum')],
        right: [cfMetric('BytesUploaded', 'Sum')],
        width: 6,
        height: 6,
      }),
    );

    // --- Infra Row 3: API Gateway ---
    infraDash.addWidgets(
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
        leftYAxis: { label: 'ms' },
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
        leftYAxis: { label: 'ms' },
        width: 6,
        height: 6,
      }),
    );

    // --- Infra Row 4: API Handler Lambda ---
    infraDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'API Handler: Invocations & Errors',
        left: [
          apiHandlerFn.metricInvocations({ period }),
          apiHandlerFn.metricErrors({ period }),
          apiHandlerFn.metricThrottles({ period }),
        ],
        stacked: true,
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Handler: Duration',
        left: [
          apiHandlerFn.metricDuration({ period, statistic: 'p50' }),
          apiHandlerFn.metricDuration({ period, statistic: 'p90' }),
          apiHandlerFn.metricDuration({ period, statistic: 'p99' }),
          apiHandlerFn.metricDuration({ period, statistic: 'Maximum' }),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Handler: Concurrent Executions',
        left: [new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'ConcurrentExecutions',
          dimensionsMap: { FunctionName: apiHandlerFn.functionName },
          statistic: 'Maximum',
          period,
        })],
        width: 8,
        height: 6,
      }),
    );

    // --- Infra Row 5: All Lambda Cross-Comparison ---
    infraDash.addWidgets(
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
        leftYAxis: { label: 'ms' },
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

    // --- Infra Row 6: Sessions DynamoDB (with Operation dimension) ---
    const sessionsDynamo = makeDynamoMetric(props.sessionsTable);
    infraDash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Sessions DynamoDB: Capacity',
        left: [
          fillZero(sessionsDynamo('ConsumedReadCapacityUnits', 'Sum'), 'Read CU'),
          fillZero(sessionsDynamo('ConsumedWriteCapacityUnits', 'Sum'), 'Write CU'),
        ],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Sessions DynamoDB: Latency',
        left: [
          sessionsDynamo('SuccessfulRequestLatency', 'Average', 'GetItem'),
          sessionsDynamo('SuccessfulRequestLatency', 'Average', 'PutItem'),
          sessionsDynamo('SuccessfulRequestLatency', 'Average', 'UpdateItem'),
          sessionsDynamo('SuccessfulRequestLatency', 'Average', 'Query'),
        ],
        leftYAxis: { label: 'ms' },
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Sessions DynamoDB: Errors',
        left: [
          sessionsDynamo('ThrottledRequests', 'Sum'),
          sessionsDynamo('UserErrors', 'Sum'),
          sessionsDynamo('SystemErrors', 'Sum'),
        ],
        width: 8,
        height: 6,
      }),
    );

    // --- Infra Row 7: S3 Overview ---
    infraDash.addWidgets(
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
        leftYAxis: { label: 'Bytes' },
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
        leftYAxis: { label: 'Bytes' },
        width: 8,
        height: 6,
      }),
    );

    // --- Infra Row 8: Application Logs ---
    infraDash.addWidgets(
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

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'TriageDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=AiSocialMedia-Triage`,
      description: 'Triage workflow CloudWatch dashboard URL',
    });
    new cdk.CfnOutput(this, 'SelectionDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=AiSocialMedia-Selection`,
      description: 'Selection/enhancement/publish workflow CloudWatch dashboard URL',
    });
    new cdk.CfnOutput(this, 'InfraDashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=AiSocialMedia-Infrastructure`,
      description: 'Infrastructure CloudWatch dashboard URL',
    });
  }
}
