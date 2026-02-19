import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface ProcessingLambdaConfig {
  description: string;
  code: lambda.DockerImageCode;
  timeout: cdk.Duration;
  memorySize: number;
  ephemeralStorageSize: cdk.Size;
  environment: Record<string, string>;
}

/**
 * Creates a Docker-based Lambda function for processing workloads.
 * Shared factory for the 9 processing Lambdas (API, Triage, Description, etc.).
 */
export function createProcessingLambda(
  scope: Construct,
  id: string,
  config: ProcessingLambdaConfig,
): lambda.DockerImageFunction {
  return new lambda.DockerImageFunction(scope, id, {
    description: config.description,
    code: config.code,
    architecture: lambda.Architecture.ARM_64,
    timeout: config.timeout,
    memorySize: config.memorySize,
    ephemeralStorageSize: config.ephemeralStorageSize,
    environment: config.environment,
  });
}
