import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { Construct } from 'constructs';

/** Named Lambda entry for construct-ID-safe iteration */
export interface NamedLambda {
  /** Human-readable name for construct IDs (e.g. 'ApiHandler', 'VideoProcessor') */
  id: string;
  /** The Lambda function */
  fn: lambda.IFunction;
}

export interface OperationsAlertStackProps extends cdk.StackProps {
  /** All Lambda functions to monitor, with stable names for construct IDs */
  lambdas: NamedLambda[];
  /** API Gateway HTTP API */
  httpApi: apigwv2.HttpApi;
  /** Email for alarm notifications (optional, pass via -c alertEmail=...) */
  alertEmail?: string;
}

/**
 * OperationsAlertStack provides financial-risk alarms and X-Ray tracing (DDR-047: split from OperationsStack).
 *
 * Components:
 * - SNS alert topic with optional email subscription
 * - 1 CloudWatch alarm (API Gateway 4xx spike for abuse/DDoS detection)
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

    // --- API Gateway 4xx Spike Alarm (abuse/DDoS detection) ---
    const apiMetric = (metricName: string, stat: string, period: cdk.Duration) =>
      new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        dimensionsMap: { ApiId: props.httpApi.apiId },
        statistic: stat,
        period,
      });

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

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic ARN for alarm notifications',
    });
  }
}
