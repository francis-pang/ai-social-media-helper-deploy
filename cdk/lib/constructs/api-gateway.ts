import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';

export interface ApiGatewayProps {
  /** API Lambda that handles all HTTP requests */
  apiHandler: lambda.IFunction;
  /** CloudFront domain for CORS lockdown (DDR-028) */
  cloudFrontDomain?: string;
}

/**
 * ApiGateway creates Cognito auth and API Gateway HTTP API (DDR-028).
 *
 * Components:
 * - Cognito User Pool (no public signup, provisioned via AWS CLI)
 * - Cognito User Pool Client (SPA-friendly: no secret, SRP + password auth)
 * - HTTP API with JWT authorizer, CORS lockdown, throttling
 * - /api/{proxy+} route (authenticated) + /api/health route (public)
 */
export class ApiGateway extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: ApiGatewayProps) {
    super(scope, id);

    // =====================================================================
    // Cognito User Pool (DDR-028 Problem 2)
    // =====================================================================
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

    // =====================================================================
    // API Gateway HTTP API (DDR-028: CORS lockdown + throttling)
    // =====================================================================
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
      props.apiHandler,
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
  }
}
