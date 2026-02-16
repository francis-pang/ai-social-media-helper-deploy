import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
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
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Risk 23: Protect user accounts from accidental stack deletion
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
      // Risk 20: Explicitly disable implicit OAuth flow (security best practice).
      // This SPA uses direct SRP/password auth, not OAuth redirects.
      // Only authorization code grant with PKCE is permitted if OAuth is ever needed.
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: false,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE, cognito.OAuthScope.EMAIL],
        callbackUrls: props.cloudFrontDomain
          ? [`https://${props.cloudFrontDomain}/`]
          : ['https://localhost/'],
        logoutUrls: props.cloudFrontDomain
          ? [`https://${props.cloudFrontDomain}/`]
          : ['https://localhost/'],
      },
    });

    // =====================================================================
    // API Gateway HTTP API (DDR-028: CORS lockdown + throttling)
    // =====================================================================
    const issuer = this.userPool.userPoolProviderUrl;
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('CognitoAuthorizer', issuer, {
      jwtAudience: [this.userPoolClient.userPoolClientId],
      identitySource: ['$request.header.Authorization'],
    });

    // Risk 7: CORS locked to the CloudFront domain. Falls back to '*' only on
    // first deploy before FrontendStack writes the domain to SSM. Subsequent
    // deploys will always have the domain via SSM lookup in cdk.ts.
    const allowedOrigins = props.cloudFrontDomain
      ? [`https://${props.cloudFrontDomain}`]
      : ['*'];
    if (!props.cloudFrontDomain) {
      cdk.Annotations.of(this).addWarningV2(
        'cors-wildcard-fallback',
        'CORS is set to * because cloudFrontDomain is not configured. ' +
        'Deploy FrontendStack first, then re-deploy Backend to lock CORS.',
      );
    }

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'AiSocialMediaApi',
      description: 'Main API — JWT-authenticated routes for media sessions, AI pipelines, and Instagram publishing',
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

    // DDR-062: API Gateway access logging — captures requests rejected by the JWT
    // authorizer before reaching the Lambda (auth errors, throttling, routing failures).
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLog', {
      logGroupName: '/aws/apigateway/AiSocialMediaApi',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // API Gateway throttling (DDR-028 Problem 10) + access logging (DDR-062)
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild as cdk.CfnResource;
    if (cfnStage) {
      cfnStage.addPropertyOverride('DefaultRouteSettings', {
        ThrottlingBurstLimit: 100,
        ThrottlingRateLimit: 50,
      });
      cfnStage.addPropertyOverride('AccessLogSettings', {
        DestinationArn: accessLogGroup.logGroupArn,
        Format: JSON.stringify({
          requestId: '$context.requestId',
          ip: '$context.identity.sourceIp',
          method: '$context.httpMethod',
          path: '$context.path',
          status: '$context.status',
          responseLength: '$context.responseLength',
          latency: '$context.responseLatency',
          integrationError: '$context.integrationErrorMessage',
          authorizerError: '$context.authorizer.error',
        }),
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

    // Thumbnail endpoint without JWT auth — served via <img src=...> which cannot
    // send Authorization headers. Still protected by CloudFront's x-origin-verify
    // custom header (DDR-028), so direct API Gateway access is blocked.
    this.httpApi.addRoutes({
      path: '/api/media/thumbnail',
      methods: [apigwv2.HttpMethod.GET],
      integration: lambdaIntegration,
    });
  }
}
