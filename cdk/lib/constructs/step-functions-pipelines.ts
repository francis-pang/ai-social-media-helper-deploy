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
  /** Gemini Batch Poll Lambda for polling batch job status (DDR-077) */
  geminiBatchPollProcessor: lambda.IFunction;
  /** FB Prep Lambda for AI-powered Facebook caption generation (DDR-082) */
  fbPrepProcessor: lambda.IFunction;
  /** FB Prep GCS Upload Lambda for uploading videos from S3 to GCS (batch mode) */
  fbPrepGcsUploadProcessor: lambda.IFunction;
  /** FB Prep Collect Batch Lambda for collecting and merging Vertex AI batch results */
  fbPrepCollectBatchProcessor: lambda.IFunction;
  /** FB Prep Submit Batch Lambda for submitting batch jobs to Vertex AI */
  fbPrepSubmitBatchProcessor: lambda.IFunction;
}

/**
 * StepFunctionsPipelines creates the 4 Step Functions state machines (DDR-035, DDR-052).
 *
 * Pipelines:
 * - SelectionPipeline: Map(thumbnails) -> Selection Lambda
 * - EnhancementPipeline: Parallel(Map(photos) + Map(videos))
 * - TriagePipeline: Prepare -> [has videos?] -> poll Gemini -> Run (DDR-052)
 * - PublishPipeline: CreateContainers -> [has videos?] -> poll Instagram -> Finalize (DDR-052)
 * - GeminiBatchPollPipeline: Wait -> Poll -> [done?] -> Succeed/Fail (DDR-077)
 */
export class StepFunctionsPipelines extends Construct {
  public readonly selectionPipeline: sfn.StateMachine;
  public readonly enhancementPipeline: sfn.StateMachine;
  public readonly triagePipeline: sfn.StateMachine;
  public readonly publishPipeline: sfn.StateMachine;
  public readonly geminiBatchPollPipeline: sfn.StateMachine;
  public readonly fbPrepPipeline: sfn.StateMachine;

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

    // =====================================================================
    // Gemini Batch Poll Pipeline (DDR-077)
    // =====================================================================
    // Wait 15s -> Poll batch status -> [SUCCEEDED|FAILED|loop]
    // Input: { batch_job_id: string, workflow_type: string, session_id: string }
    const geminiBatchWait = new sfn.Wait(this, 'GeminiBatchWait', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(15)),
    });

    const geminiBatchCheck = new tasks.LambdaInvoke(this, 'GeminiBatchCheck', {
      lambdaFunction: props.geminiBatchPollProcessor,
      payload: sfn.TaskInput.fromObject({
        'batch_job_id.$': '$.batch_job_id',
      }),
      resultPath: '$.poll_result',
      retryOnServiceExceptions: true,
    });
    geminiBatchCheck.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
    });

    const geminiBatchComplete = new sfn.Succeed(this, 'GeminiBatchComplete');
    const geminiBatchFailed = new sfn.Fail(this, 'GeminiBatchFailed', {
      error: 'GeminiBatchFailed',
    });

    const geminiBatchIsDone = new sfn.Choice(this, 'GeminiBatchIsDone')
      .when(sfn.Condition.stringEquals('$.poll_result.Payload.state', 'JOB_STATE_SUCCEEDED'), geminiBatchComplete)
      .when(sfn.Condition.stringEquals('$.poll_result.Payload.state', 'JOB_STATE_FAILED'), geminiBatchFailed)
      .otherwise(geminiBatchWait);

    this.geminiBatchPollPipeline = new sfn.StateMachine(this, 'GeminiBatchPollPipeline', {
      stateMachineName: 'AiSocialMediaGeminiBatchPollPipeline',
      comment: 'Poll Gemini Batch API job status until complete or failed (DDR-077)',
      definitionBody: sfn.DefinitionBody.fromChainable(
        geminiBatchWait.next(geminiBatchCheck).next(geminiBatchIsDone),
      ),
      timeout: cdk.Duration.minutes(30),
    });

    // =====================================================================
    // FBPrep Pipeline (DDR-082)
    // =====================================================================
    // RunFBPrep → [batch?] → StartGeminiBatchPoll → CollectBatchResults → Succeed
    //                      → Succeed (real-time, already complete)
    const runFBPrep = new tasks.LambdaInvoke(this, 'RunFBPrep', {
      lambdaFunction: props.fbPrepProcessor,
      payload: sfn.TaskInput.fromObject({
        type: 'fb-prep',
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'mediaKeys.$': '$.mediaKeys',
        'economyMode.$': '$.economyMode',
      }),
      resultPath: '$.prep_result',
      retryOnServiceExceptions: true,
    });
    runFBPrep.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 1,
      backoffRate: 2,
    });

    const fbPrepSucceed = new sfn.Succeed(this, 'FBPrepSucceed');

    const collectBatchResultsPayload = {
      'sessionId.$': '$.sessionId',
      'jobId.$': '$.prep_result.Payload.job_id',
      'batchJobId.$': '$.submit_result.Payload.batch_job_id',
      'batchJobIds.$': '$.submit_result.Payload.batch_job_ids',
    };
    const collectBatchResultsSingle = new tasks.LambdaInvoke(this, 'CollectBatchResultsSingle', {
      lambdaFunction: props.fbPrepCollectBatchProcessor,
      payload: sfn.TaskInput.fromObject(collectBatchResultsPayload),
      resultPath: sfn.JsonPath.DISCARD,
      retryOnServiceExceptions: true,
    });
    collectBatchResultsSingle.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
    });
    const collectBatchResultsMulti = new tasks.LambdaInvoke(this, 'CollectBatchResultsMulti', {
      lambdaFunction: props.fbPrepCollectBatchProcessor,
      payload: sfn.TaskInput.fromObject(collectBatchResultsPayload),
      resultPath: sfn.JsonPath.DISCARD,
      retryOnServiceExceptions: true,
    });
    collectBatchResultsMulti.addRetry({
      errors: ['States.ALL'],
      maxAttempts: 2,
      backoffRate: 2,
    });

    // Catch handler: if GeminiBatchPollPipeline fails, mark the job as error in DynamoDB
    // so the frontend stops polling and shows an actionable error (DDR-085).
    const fbPrepFail = new sfn.Fail(this, 'FBPrepFail', {
      error: 'BatchPollFailed',
      cause: 'Gemini batch poll pipeline failed; job marked as error in DynamoDB',
    });
    const markBatchError = new tasks.LambdaInvoke(this, 'MarkBatchError', {
      lambdaFunction: props.fbPrepProcessor,
      payload: sfn.TaskInput.fromObject({
        type: 'fb-prep-mark-error',
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.jobId',
        'collectError.$': '$.collectError',
        'batchError.$': '$.batchError',
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    const markBatchErrorChain = markBatchError.next(fbPrepFail);
    collectBatchResultsSingle.addCatch(markBatchErrorChain, {
      resultPath: '$.collectError',
    });
    collectBatchResultsMulti.addCatch(markBatchErrorChain, {
      resultPath: '$.collectError',
    });

    // Poll one batch job (used by Map for multi-batch).
    // NOTE: Use $ not $$.Map.Item.Value in processor. Processor receives ItemSelector output.
    const pollOneBatch = new tasks.StepFunctionsStartExecution(this, 'PollOneBatch', {
      stateMachine: this.geminiBatchPollPipeline,
      input: sfn.TaskInput.fromObject({
        'batch_job_id.$': '$.batch_job_id',
      }),
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Economy: Map uploads each video to GCS (one Lambda per video), then Submit, then Poll -> Collect.
    // NOTE: $$.Map.Item.Value is only valid in ItemSelector. Processor receives ItemSelector output; use $.
    const uploadVideoToGCS = new tasks.LambdaInvoke(this, 'UploadVideoToGCS', {
      lambdaFunction: props.fbPrepGcsUploadProcessor,
      payload: sfn.TaskInput.fromObject({
        's3_key.$': '$.s3_key',
        'use_key.$': '$.use_key',
        'job_id.$': '$.job_id',
        'batch_index.$': '$.batch_index',
        'item_index_in_batch.$': '$.item_index_in_batch',
      }),
      resultPath: sfn.JsonPath.DISCARD,
      retryOnServiceExceptions: true,
    });
    const mapUploadVideos = new sfn.Map(this, 'MapUploadVideos', {
      itemsPath: '$.prep_result.Payload.videos_to_upload',
      maxConcurrency: 10,
      resultPath: '$.gcsUploadResults',
      itemSelector: {
        's3_key.$': '$$.Map.Item.Value.s3_key',
        'use_key.$': '$$.Map.Item.Value.use_key',
        'job_id.$': '$$.Map.Item.Value.job_id',
        'batch_index.$': '$$.Map.Item.Value.batch_index',
        'item_index_in_batch.$': '$$.Map.Item.Value.item_index_in_batch',
      },
    });
    mapUploadVideos.itemProcessor(uploadVideoToGCS);
    mapUploadVideos.addCatch(markBatchErrorChain, { resultPath: '$.batchError' });

    const runFBPrepSubmit = new tasks.LambdaInvoke(this, 'RunFBPrepSubmit', {
      lambdaFunction: props.fbPrepSubmitBatchProcessor,
      payload: sfn.TaskInput.fromObject({
        'sessionId.$': '$.sessionId',
        'jobId.$': '$.prep_result.Payload.job_id',
        'batchesMeta.$': '$.prep_result.Payload.batches_meta',
        'locationTags.$': '$.prep_result.Payload.location_tags',
        'gcsUploadResults.$': '$.gcsUploadResults',
      }),
      resultPath: '$.submit_result',
      retryOnServiceExceptions: true,
    });
    runFBPrepSubmit.addRetry({ errors: ['States.ALL'], maxAttempts: 1, backoffRate: 2 });
    runFBPrepSubmit.addCatch(markBatchErrorChain, { resultPath: '$.collectError' });

    const pollFromSubmit = new tasks.StepFunctionsStartExecution(this, 'PollFromSubmit', {
      stateMachine: this.geminiBatchPollPipeline,
      input: sfn.TaskInput.fromObject({
        'batch_job_id.$': '$.submit_result.Payload.batch_job_id',
      }),
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      resultPath: sfn.JsonPath.DISCARD,
    });
    pollFromSubmit.addCatch(markBatchErrorChain, { resultPath: '$.batchError' });

    const mapPollsFromSubmit = new sfn.Map(this, 'MapPollsFromSubmit', {
      itemsPath: '$.submit_result.Payload.batch_job_ids',
      maxConcurrency: 5,
      resultPath: sfn.JsonPath.DISCARD,
      itemSelector: { 'batch_job_id.$': '$$.Map.Item.Value' },
    });
    mapPollsFromSubmit.itemProcessor(pollOneBatch);
    mapPollsFromSubmit.addCatch(markBatchErrorChain, { resultPath: '$.batchError' });

    const setOldLambdaError = new sfn.Pass(this, 'SetOldLambdaError', {
      parameters: {
        Cause:
          'RunFBPrep returned batch_job_id (inline submit). Deploy the new fb-prep Lambda that returns batches_meta + videos_to_upload for GCS-based economy mode.',
      },
      resultPath: '$.collectError',
    });

    const fbPrepIsBatch = new sfn.Choice(this, 'FBPrepIsBatch')
      .when(
        sfn.Condition.isPresent('$.prep_result.Payload.batches_meta'),
        mapUploadVideos.next(runFBPrepSubmit).next(
          new sfn.Choice(this, 'FBPrepSingleOrMulti')
            .when(
              sfn.Condition.isPresent('$.submit_result.Payload.batch_job_ids'),
              mapPollsFromSubmit.next(collectBatchResultsMulti).next(fbPrepSucceed),
            )
            .when(
              sfn.Condition.isPresent('$.submit_result.Payload.batch_job_id'),
              pollFromSubmit.next(collectBatchResultsSingle).next(fbPrepSucceed),
            )
            .otherwise(fbPrepSucceed),
        ),
      )
      .when(
        sfn.Condition.or(
          sfn.Condition.isPresent('$.prep_result.Payload.batch_job_id'),
          sfn.Condition.isPresent('$.prep_result.Payload.batch_job_ids'),
        ),
        setOldLambdaError.next(markBatchErrorChain),
      )
      .otherwise(fbPrepSucceed);

    this.fbPrepPipeline = new sfn.StateMachine(this, 'FBPrepPipeline', {
      stateMachineName: 'AiSocialMediaFBPrepPipeline',
      comment: 'FB Prep — economy mode dispatches to Gemini Batch, real-time resolves immediately (DDR-082)',
      definitionBody: sfn.DefinitionBody.fromChainable(runFBPrep.next(fbPrepIsBatch)),
      timeout: cdk.Duration.minutes(90),
    });
  }
}
