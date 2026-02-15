import * as cdk from 'aws-cdk-lib/core';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

export interface StepFunctionsPipelinesProps {
  /** Thumbnail Lambda for Selection pipeline Map state */
  thumbnailProcessor: lambda.IFunction;
  /** Selection Lambda for AI media selection */
  selectionProcessor: lambda.IFunction;
  /** Enhancement Lambda for per-photo AI editing */
  enhancementProcessor: lambda.IFunction;
  /** Video Lambda for per-video ffmpeg processing */
  videoProcessor: lambda.IFunction;
  /** Triage Lambda for triage pipeline steps (DDR-052, DDR-053) */
  triageProcessor: lambda.IFunction;
  /** Publish Lambda for publish pipeline steps (DDR-052, DDR-053) */
  publishProcessor: lambda.IFunction;
}

/**
 * StepFunctionsPipelines creates the 4 Step Functions state machines (DDR-035, DDR-052).
 *
 * Pipelines:
 * - SelectionPipeline: Map(thumbnails) -> Selection Lambda
 * - EnhancementPipeline: Parallel(Map(photos) + Map(videos))
 * - TriagePipeline: Prepare -> [has videos?] -> poll Gemini -> Run (DDR-052)
 * - PublishPipeline: CreateContainers -> [has videos?] -> poll Instagram -> Finalize (DDR-052)
 */
export class StepFunctionsPipelines extends Construct {
  public readonly selectionPipeline: sfn.StateMachine;
  public readonly enhancementPipeline: sfn.StateMachine;
  public readonly triagePipeline: sfn.StateMachine;
  public readonly publishPipeline: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: StepFunctionsPipelinesProps) {
    super(scope, id);

    // =====================================================================
    // Selection Pipeline
    // =====================================================================
    // Map: generate thumbnails (parallel, per file) -> Selection Lambda (Gemini AI)
    const generateThumbnails = new tasks.LambdaInvoke(this, 'GenerateThumbnails', {
      lambdaFunction: props.thumbnailProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    generateThumbnails.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
    });

    const thumbnailMap = new sfn.Map(this, 'ThumbnailMap', {
      maxConcurrency: 20,
      itemsPath: '$.mediaKeys',
      resultPath: '$.thumbnailKeys',
      itemSelector: {
        'sessionId.$': '$.sessionId',
        'key.$': '$$.Map.Item.Value',
      },
    });
    thumbnailMap.itemProcessor(generateThumbnails);

    const runSelection = new tasks.LambdaInvoke(this, 'RunSelection', {
      lambdaFunction: props.selectionProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    runSelection.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    this.selectionPipeline = new sfn.StateMachine(this, 'SelectionPipeline', {
      stateMachineName: 'AiSocialMediaSelectionPipeline',
      comment: 'Generate thumbnails in parallel, then run Gemini AI to rank and select the best media',
      definitionBody: sfn.DefinitionBody.fromChainable(thumbnailMap.next(runSelection)),
      timeout: cdk.Duration.minutes(30),
    });

    // =====================================================================
    // Enhancement Pipeline
    // =====================================================================
    // Parallel: (Map: enhance photos) + (Map: process videos)
    const enhancePhoto = new tasks.LambdaInvoke(this, 'EnhancePhoto', {
      lambdaFunction: props.enhancementProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    enhancePhoto.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
    });

    const photoMap = new sfn.Map(this, 'PhotoEnhancementMap', {
      maxConcurrency: 10,
      itemsPath: '$.photos',
      itemSelector: {
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'key.$': '$$.Map.Item.Value',
        'itemIndex.$': '$$.Map.Item.Index',
      },
    });
    photoMap.itemProcessor(enhancePhoto);

    const processVideo = new tasks.LambdaInvoke(this, 'ProcessVideo', {
      lambdaFunction: props.videoProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    processVideo.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    const videoMap = new sfn.Map(this, 'VideoProcessingMap', {
      maxConcurrency: 5,
      itemsPath: '$.videos',
      itemSelector: {
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'key.$': '$$.Map.Item.Value',
        'itemIndex.$': '$$.Map.Item.Index',
      },
    });
    videoMap.itemProcessor(processVideo);

    const parallelEnhance = new sfn.Parallel(this, 'ParallelEnhance', {
      resultPath: '$.enhancementResults',
    });
    parallelEnhance.branch(photoMap);
    parallelEnhance.branch(videoMap);

    this.enhancementPipeline = new sfn.StateMachine(this, 'EnhancementPipeline', {
      stateMachineName: 'AiSocialMediaEnhancementPipeline',
      comment: 'Parallel branches: AI photo editing (Gemini) + video ffmpeg processing per file',
      definitionBody: sfn.DefinitionBody.fromChainable(parallelEnhance),
      timeout: cdk.Duration.minutes(30),
    });

    // =====================================================================
    // Triage Pipeline (DDR-061: S3 event-driven per-file processing)
    // =====================================================================
    // InitSession -> Poll(processedCount == expectedFileCount) -> TriageRun
    // MediaProcess Lambda handles per-file processing via S3 events.
    // The SFN polls DynamoDB every 3 seconds until all files are processed.
    const triageInitSession = new tasks.LambdaInvoke(this, 'TriageInitSession', {
      lambdaFunction: props.triageProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    triageInitSession.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    const triageCheckProcessing = new tasks.LambdaInvoke(this, 'TriageCheckProcessing', {
      lambdaFunction: props.triageProcessor,
      payload: sfn.TaskInput.fromObject({
        'type': 'triage-check-processing',
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'model.$': '$.model',
      }),
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    const triageRunTriage = new tasks.LambdaInvoke(this, 'TriageRunTriage', {
      lambdaFunction: props.triageProcessor,
      payload: sfn.TaskInput.fromObject({
        'type': 'triage-run',
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'model.$': '$.model',
      }),
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    triageRunTriage.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    const triageProcessingWait = new sfn.Wait(this, 'TriageProcessingWait', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(3)),
    });

    // Choice: are all files processed?
    const triageAllProcessed = new sfn.Choice(this, 'TriageAllProcessed')
      .when(sfn.Condition.booleanEquals('$.allProcessed', true), triageRunTriage)
      .otherwise(triageProcessingWait.next(triageCheckProcessing));

    this.triagePipeline = new sfn.StateMachine(this, 'TriagePipeline', {
      stateMachineName: 'AiSocialMediaTriagePipeline',
      comment: 'S3 event-driven triage: init session, poll for per-file processing completion, then run AI triage (DDR-061)',
      definitionBody: sfn.DefinitionBody.fromChainable(
        triageInitSession.next(triageCheckProcessing).next(triageAllProcessed),
      ),
      timeout: cdk.Duration.minutes(30),
    });

    // =====================================================================
    // Publish Pipeline (DDR-052)
    // =====================================================================
    // CreateContainers -> [has videos?] -> poll Instagram status -> PublishPost
    // Wait states eliminate idle Lambda compute during Instagram video processing.
    const publishCreateContainers = new tasks.LambdaInvoke(this, 'PublishCreateContainers', {
      lambdaFunction: props.publishProcessor,
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    publishCreateContainers.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    const publishCheckVideo = new tasks.LambdaInvoke(this, 'PublishCheckVideo', {
      lambdaFunction: props.publishProcessor,
      payload: sfn.TaskInput.fromObject({
        'type': 'publish-check-video',
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'groupId.$': '$.groupId',
        'caption.$': '$.caption',
        'containerIDs.$': '$.containerIDs',
        'videoContainerIDs.$': '$.videoContainerIDs',
        'isCarousel.$': '$.isCarousel',
      }),
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });

    const publishFinalize = new tasks.LambdaInvoke(this, 'PublishFinalize', {
      lambdaFunction: props.publishProcessor,
      payload: sfn.TaskInput.fromObject({
        'type': 'publish-finalize',
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'groupId.$': '$.groupId',
        'caption.$': '$.caption',
        'containerIDs.$': '$.containerIDs',
        'isCarousel.$': '$.isCarousel',
      }),
      outputPath: '$.Payload',
      retryOnServiceExceptions: true,
    });
    publishFinalize.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
    });

    const publishVideoWait = new sfn.Wait(this, 'PublishVideoWait', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(10)),
    });

    // Choice: are all video containers finished?
    const publishAllFinished = new sfn.Choice(this, 'PublishAllFinished')
      .when(sfn.Condition.booleanEquals('$.allFinished', true), publishFinalize)
      .otherwise(publishVideoWait.next(publishCheckVideo));

    // Choice: does the post have videos?
    const publishHasVideos = new sfn.Choice(this, 'PublishHasVideos')
      .when(sfn.Condition.booleanEquals('$.hasVideos', true), publishCheckVideo.next(publishAllFinished))
      .otherwise(publishFinalize);

    this.publishPipeline = new sfn.StateMachine(this, 'PublishPipeline', {
      stateMachineName: 'AiSocialMediaPublishPipeline',
      comment: 'Create Instagram media containers, poll video processing status, then publish the post',
      definitionBody: sfn.DefinitionBody.fromChainable(publishCreateContainers.next(publishHasVideos)),
      timeout: cdk.Duration.minutes(30),
    });
  }
}
