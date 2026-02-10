import * as cdk from 'aws-cdk-lib/core';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as glue from 'aws-cdk-lib/aws-glue';
import { Construct } from 'constructs';

import { NamedLambda } from './operations-alert-stack.js';

export interface OperationsMonitoringStackProps extends cdk.StackProps {
  /** All Lambda functions to monitor, with stable names for construct IDs */
  lambdas: NamedLambda[];
  /** Log archive S3 bucket (from StorageStack — DDR-045: stateful/stateless split) */
  logArchiveBucket: s3.IBucket;
  /** Metrics archive S3 bucket (from StorageStack — DDR-045: optional, stateful/stateless split) */
  metricsArchiveBucket?: s3.IBucket;
}

/**
 * OperationsMonitoringStack provides log ingestion, metric filters, and
 * archival infrastructure (DDR-047, DDR-054: split from dashboard).
 *
 * Components:
 * - 2 Firehose delivery streams (INFO+ and DEBUG logs -> S3)
 * - 54 metric filters (6 per Lambda × 9 Lambdas)
 * - 18 subscription filters (2 per Lambda for Firehose archival)
 * - Glue database + table for Athena querying
 * - Metric Streams -> Firehose -> S3 for long-term metric archival (DDR-047)
 *
 * This stack changes rarely and is slower to deploy (~2-3 min).
 * See also: OperationsDashboardStack for the CloudWatch dashboard.
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
  }
}
