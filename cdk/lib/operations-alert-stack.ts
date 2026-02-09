import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

/** Named Lambda entry for construct-ID-safe iteration */
export interface NamedLambda {
  /** Human-readable name for construct IDs (e.g. 'ApiHandler', 'VideoProcessor') */
  id: string;
  /** The Lambda function */
  fn: lambda.Function;
}

export interface OperationsAlertStackProps extends cdk.StackProps {
  /** All Lambda functions to monitor, with stable names for construct IDs */
  lambdas: NamedLambda[];
  /** API Gateway HTTP API */
  httpApi: apigwv2.HttpApi;
  /** Step Functions state machines */
  selectionPipeline: sfn.StateMachine;
  enhancementPipeline: sfn.StateMachine;
  /** Email for alarm notifications (optional, pass via -c alertEmail=...) */
  alertEmail?: string;
}

/**
 * OperationsAlertStack provides alarms and X-Ray tracing (DDR-047: split from OperationsStack).
 *
 * Components:
 * - SNS alert topic with optional email subscription
 * - 17 CloudWatch alarms (Lambda errors/throttles, duration, API Gateway, Step Functions)
 * - X-Ray active tracing on all Lambdas
 *
 * This stack changes often (alarm threshold tweaks) and deploys fast (~1-2 min).
 * See also: OperationsMonitoringStack for dashboard, metric filters, and log archival.
 */
export class OperationsAlertStack extends cdk.Stack {
  /** SNS alert topic — exposed for cross-stack references */
  public readonly alertTopic: sns.Topic;
  /** All alarms — exposed for dashboard alarm status widget */
  public readonly alarms: cloudwatch.Alarm[];

  constructor(scope: Construct, id: string, props: OperationsAlertStackProps) {
    super(scope, id, props);

    const lambdas = props.lambdas;

    // =========================================================================
    // SNS Alert Topic
    // =========================================================================
    this.alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: 'AiSocialMediaAlerts',
      displayName: 'AI Social Media Helper Alerts',
    });

    if (props.alertEmail) {
      this.alertTopic.addSubscription(
        new sns_subscriptions.EmailSubscription(props.alertEmail),
      );
    }

    // =========================================================================
    // X-Ray Active Tracing
    // =========================================================================
    for (const { fn } of lambdas) {
      const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
      cfnFn.addPropertyOverride('TracingConfig', { Mode: 'Active' });
    }

    // =========================================================================
    // CloudWatch Alarms
    // =========================================================================
    this.alarms = [];

    // --- Lambda Alarms (per function) ---
    for (const { id, fn } of lambdas) {
      const errAlarm = new cloudwatch.Alarm(this, `${id}-Errors`, {
        alarmName: `AiSocialMedia-${id}-Errors`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Lambda ${id} has invocation errors`,
      });
      errAlarm.addAlarmAction(new cw_actions.SnsAction(this.alertTopic));
      this.alarms.push(errAlarm);

      const throttleAlarm = new cloudwatch.Alarm(this, `${id}-Throttles`, {
        alarmName: `AiSocialMedia-${id}-Throttles`,
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `Lambda ${id} is being throttled`,
      });
      throttleAlarm.addAlarmAction(new cw_actions.SnsAction(this.alertTopic));
      this.alarms.push(throttleAlarm);
    }

    // --- Lambda Duration Alarms (heavy Lambdas: selection=15min, enhancement=5min, video=15min) ---
    const durationAlarms: Array<{ fn: lambda.Function; maxMs: number; name: string }> = [
      { fn: lambdas[2].fn, maxMs: 12 * 60 * 1000, name: 'Selection' },   // 80% of 15min
      { fn: lambdas[3].fn, maxMs: 4 * 60 * 1000, name: 'Enhancement' },  // 80% of 5min
      { fn: lambdas[4].fn, maxMs: 12 * 60 * 1000, name: 'Video' },        // 80% of 15min
    ];

    for (const { fn, maxMs, name } of durationAlarms) {
      const alarm = new cloudwatch.Alarm(this, `${name}Duration`, {
        alarmName: `AiSocialMedia-${name}Duration`,
        metric: fn.metricDuration({
          period: cdk.Duration.minutes(5),
          statistic: 'p99',
        }),
        threshold: maxMs,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda p99 duration approaching timeout`,
      });
      alarm.addAlarmAction(new cw_actions.SnsAction(this.alertTopic));
      this.alarms.push(alarm);
    }

    // --- API Gateway Alarms ---
    const apiMetric = (metricName: string, stat: string, period: cdk.Duration) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        dimensionsMap: { ApiId: props.httpApi.apiId },
        statistic: stat,
        period,
      });

    const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxErrors', {
      alarmName: 'AiSocialMedia-Api5xxErrors',
      metric: apiMetric('5xx', 'Sum', cdk.Duration.minutes(5)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway returning 5XX errors',
    });
    api5xxAlarm.addAlarmAction(new cw_actions.SnsAction(this.alertTopic));
    this.alarms.push(api5xxAlarm);

    const api4xxAlarm = new cloudwatch.Alarm(this, 'Api4xxSpike', {
      alarmName: 'AiSocialMedia-Api4xxSpike',
      metric: apiMetric('4xx', 'Sum', cdk.Duration.minutes(5)),
      threshold: 20,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway 4XX error spike (potential abuse)',
    });
    api4xxAlarm.addAlarmAction(new cw_actions.SnsAction(this.alertTopic));
    this.alarms.push(api4xxAlarm);

    // --- Step Functions Alarms ---
    const pipelines = [
      { sm: props.selectionPipeline, name: 'SelectionPipeline' },
      { sm: props.enhancementPipeline, name: 'EnhancementPipeline' },
    ];

    for (const { sm, name } of pipelines) {
      const alarm = new cloudwatch.Alarm(this, `${name}Failed`, {
        alarmName: `AiSocialMedia-${name}Failed`,
        metric: sm.metricFailed({ period: cdk.Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Step Functions execution failed`,
      });
      alarm.addAlarmAction(new cw_actions.SnsAction(this.alertTopic));
      this.alarms.push(alarm);
    }

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic ARN for alarm notifications',
    });
  }
}
