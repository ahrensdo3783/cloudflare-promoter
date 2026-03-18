// ─────────────────────────────────────────────────────────
// src/promotion.ts — Promotion plans, strategies, state machine
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type ActionInputs,
  type DeploymentLifecycle,
  type DeployResult,
  type LifecycleTracker,
  type PromotionFailure,
  type PromotionPlan,
  type PromotionResult,
  type PromotionStep,
  type PromotionStepResult,
  type ReleaseContext,
  type RollbackResult,
} from './types';
import * as cloudflare from './cloudflare';
import { runSmokeTest } from './smoke';
import { timestamp, sleep } from './utils';

// ─── Lifecycle Helpers ───────────────────────────────────

function createLifecycleTracker(initial: DeploymentLifecycle): LifecycleTracker {
  return {
    current: initial,
    history: [{ state: initial, timestamp: timestamp() }],
  };
}

function transition(tracker: LifecycleTracker, state: DeploymentLifecycle): void {
  tracker.current = state;
  tracker.history.push({ state, timestamp: timestamp() });
  core.info(`    [lifecycle] ${state}`);
}

// ─── Plan Builder ────────────────────────────────────────

/**
 * Build a promotion plan from action inputs.
 * Normalizes user-friendly strategy names into executable step sequences.
 */
export function buildPromotionPlan(inputs: ActionInputs): PromotionPlan {
  const steps: PromotionStep[] = [];

  switch (inputs.promotionStrategy) {
    case 'immediate':
      steps.push({
        percent: 100,
        pauseAfterSeconds: 0,
        requiresPostStepSmoke: !!inputs.smokeTest,
        label: 'Full production deployment',
      });
      break;

    case 'gradual':
      for (let i = 0; i < inputs.rolloutSteps.length; i++) {
        const pct = inputs.rolloutSteps[i]!;
        const isLast = i === inputs.rolloutSteps.length - 1;
        steps.push({
          percent: pct,
          pauseAfterSeconds: isLast ? 0 : inputs.gradualStepWaitSeconds,
          requiresPostStepSmoke: inputs.postStepSmokeTests && !!inputs.smokeTest,
          label: `Gradual rollout to ${pct}%`,
        });
      }
      break;

    case 'staging-only':
      // No production steps -- candidate verified only
      break;
  }

  return {
    strategy: inputs.promotionStrategy,
    steps,
    smokeTestEnabled: !!inputs.smokeTest,
    workerName: inputs.workerName,
    environment: inputs.environment,
  };
}

// ─── Promotion Executor ──────────────────────────────────

/**
 * Execute the full promotion flow:
 *
 *  1. Look up current stable version (rollback target)
 *  2. Deploy or upload candidate
 *  3. Run candidate smoke tests (if enabled)
 *  4. For staging-only: stop after verification
 *  5. For immediate/gradual:
 *     a. Execute each promotion step
 *     b. Run post-step smoke tests (if enabled)
 *     c. On failure -> rollback to stable (if auto-rollback enabled)
 *  6. Run post-promotion verification (if enabled)
 *  7. Compute granular PromotionStatus
 *  8. Return the overall result
 */
export async function executePromotion(
  inputs: ActionInputs,
  plan: PromotionPlan,
  releaseContext?: ReleaseContext,
): Promise<PromotionResult> {
  const lifecycle = createLifecycleTracker('context_resolved');
  transition(lifecycle, 'auth_ready');

  const result: PromotionResult = {
    state: 'pending',
    stepResults: [],
    startedAt: timestamp(),
    lifecycle,
  };

  try {
    // ── Phase 1: Prepare ──
    result.state = 'deploying';
    core.info('');
    core.info('='.repeat(50));
    core.info('  Phase 1: Preparing Deployment');
    core.info('='.repeat(50));

    const previousStableVersionId = await cloudflare.lookupCurrentStableVersion(inputs);
    result.previousStableVersionId = previousStableVersionId || undefined;

    if (previousStableVersionId && inputs.autoRollback) {
      core.info(`[rollback] Rollback target recorded: ${previousStableVersionId}`);
    } else if (!previousStableVersionId) {
      core.info('[rollback] No previous version found -- rollback will not be available');
    } else if (!inputs.autoRollback) {
      core.info('[rollback] Auto-rollback is disabled by configuration');
    }

    transition(lifecycle, 'candidate_deploy_started');

    // ── Phase 2: Deploy / Upload ──
    if (plan.strategy === 'immediate') {
      return await executeImmediate(inputs, plan, result, lifecycle, releaseContext, previousStableVersionId);
    } else if (plan.strategy === 'gradual') {
      return await executeGradual(inputs, plan, result, lifecycle, releaseContext, previousStableVersionId);
    } else {
      return await executeStagingOnly(inputs, result, lifecycle, releaseContext, previousStableVersionId);
    }
  } catch (err) {
    // ── Unexpected error -- emergency recovery ──
    result.state = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
    result.completedAt = timestamp();

    const failure: PromotionFailure = {
      phase: 'unknown',
      reason: result.error,
      productionTrafficAffected: lifecycle.current === 'promotion_in_progress' || lifecycle.current === 'promoted',
      rollbackApplicable: !!result.previousStableVersionId && inputs.autoRollback,
      rollbackAttempted: false,
    };

    if (result.previousStableVersionId && inputs.autoRollback) {
      core.warning('[rollback] Unexpected error -- attempting emergency rollback');
      const rollbackResult = await performRollback(
        result.previousStableVersionId,
        inputs,
        lifecycle,
      );
      result.rollback = rollbackResult;
      failure.rollbackAttempted = true;
      failure.rollbackSucceeded = rollbackResult.success;

      if (rollbackResult.success) {
        result.state = 'rolled-back';
        result.promotionStatus = 'failed-rollback-succeeded';
      } else {
        result.promotionStatus = 'failed-rollback-failed';
      }
    } else if (result.previousStableVersionId && !inputs.autoRollback) {
      core.warning('[rollback] Auto-rollback is disabled -- skipping recovery');
      result.promotionStatus = 'failed-rollback-disabled';
    } else {
      core.warning('[rollback] No previous version available for rollback');
      result.promotionStatus = 'failed-no-rollback';
    }

    result.failure = failure;
    return result;
  }
}

// ─── Strategy: Immediate ─────────────────────────────────

async function executeImmediate(
  inputs: ActionInputs,
  _plan: PromotionPlan,
  result: PromotionResult,
  lifecycle: LifecycleTracker,
  releaseContext?: ReleaseContext,
  previousStableVersionId?: string,
): Promise<PromotionResult> {
  core.info('');
  core.info('='.repeat(50));
  core.info('  Phase 2: Deploying (immediate 100%)');
  core.info('='.repeat(50));

  const deployResult = await cloudflare.deployCandidate(inputs, releaseContext);
  result.deploy = deployResult;

  if (!deployResult.success) {
    result.state = 'failed';
    result.error = `Deployment failed: ${deployResult.stderr}`;
    result.completedAt = timestamp();
    result.failure = {
      phase: 'candidate-deploy',
      reason: result.error,
      productionTrafficAffected: false, // Deploy failed, no traffic touched
      rollbackApplicable: false, // Nothing changed, rollback unnecessary
      rollbackAttempted: false,
    };
    result.promotionStatus = 'failed-no-rollback';
    transition(lifecycle, 'failed');
    core.info('[rollback] Deploy failed before any traffic change -- rollback not needed');
    return result;
  }

  transition(lifecycle, 'candidate_deployed');
  logCandidateSummary(deployResult, previousStableVersionId);

  // ── Candidate smoke test ──
  if (inputs.smokeTest) {
    const smokeResult = await runCandidateSmokeTest(inputs, lifecycle);
    result.candidateSmokeResult = smokeResult;

    if (!smokeResult.passed) {
      result.stepResults.push({
        percentage: 100,
        success: false,
        message: `Candidate smoke test failed: ${smokeResult.failureReason}`,
        smokeTest: smokeResult,
      });

      return await handleFailure(
        inputs, result, lifecycle, previousStableVersionId,
        'candidate-smoke',
        `Candidate smoke test failed: ${smokeResult.failureReason || 'Unexpected failure'}`,
        true, // Production traffic was affected (immediate mode deployed to 100%)
      );
    }

    transition(lifecycle, 'candidate_verified');
  }

  // Record the step result
  const stepResult: PromotionStepResult = {
    percentage: 100,
    success: true,
    message: `Deployed version ${deployResult.versionId || 'unknown'}`,
    smokeTest: result.candidateSmokeResult,
  };
  result.stepResults.push(stepResult);

  // ── Post-promotion smoke test ──
  if (inputs.smokeTest) {
    const postSmokeResult = await runPostPromotionSmokeTest(inputs, lifecycle);
    result.postPromotionSmokeResult = postSmokeResult;

    if (!postSmokeResult.passed) {
      return await handleFailure(
        inputs, result, lifecycle, previousStableVersionId,
        'post-promotion-smoke',
        `Post-promotion smoke test failed: ${postSmokeResult.failureReason || 'Unexpected failure'}`,
        true,
      );
    }

    transition(lifecycle, 'post_promotion_verified');
  }

  result.state = 'complete';
  result.promotionStatus = 'success';
  result.completedAt = timestamp();
  transition(lifecycle, 'promoted');
  return result;
}

// ─── Strategy: Gradual ───────────────────────────────────

async function executeGradual(
  inputs: ActionInputs,
  plan: PromotionPlan,
  result: PromotionResult,
  lifecycle: LifecycleTracker,
  releaseContext?: ReleaseContext,
  previousStableVersionId?: string,
): Promise<PromotionResult> {
  core.info('');
  core.info('='.repeat(50));
  core.info('  Phase 2: Uploading Version (Gradual Rollout)');
  core.info('='.repeat(50));

  const newVersionId = await cloudflare.uploadVersion(inputs);
  transition(lifecycle, 'candidate_deployed');

  // Populate deploy result for gradual flow
  result.deploy = {
    success: true,
    versionId: newVersionId,
    workerName: inputs.workerName,
    releaseTag: releaseContext?.tagName,
    sourceTrigger: github.context.eventName,
    gitSha: github.context.sha,
    gitRef: github.context.ref,
    deployedAt: timestamp(),
    stdout: '',
    stderr: '',
  };

  // Give Cloudflare a moment to register the version
  await sleep(2000);

  // ── Candidate smoke test (before any promotion) ──
  if (inputs.smokeTest && inputs.smokeTest.checks.length > 0) {
    const smokeResult = await runCandidateSmokeTest(inputs, lifecycle);
    result.candidateSmokeResult = smokeResult;

    if (!smokeResult.passed) {
      return await handleFailure(
        inputs, result, lifecycle, previousStableVersionId,
        'candidate-smoke',
        `Candidate smoke test failed before gradual rollout: ${smokeResult.failureReason || 'Unexpected failure'}`,
        false, // No production traffic affected yet
      );
    }

    transition(lifecycle, 'candidate_verified');
  }

  // ── Gradual steps ──
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    transition(lifecycle, 'promotion_in_progress');

    core.info('');
    core.info('='.repeat(50));
    core.info(`  Step ${i + 1}/${plan.steps.length}: ${step.label}`);
    core.info('='.repeat(50));

    const stepResult = await cloudflare.promoteVersion(
      newVersionId,
      step.percent,
      inputs,
      previousStableVersionId,
    );

    // Promotion step failed
    if (!stepResult.success) {
      core.error(`[promotion] Step failed at ${step.percent}% -- initiating recovery`);
      result.stepResults.push(stepResult);

      return await handleFailure(
        inputs, result, lifecycle, previousStableVersionId,
        'promotion-step',
        `Promotion failed at ${step.percent}%: ${stepResult.message}`,
        true, // Some traffic may have shifted
        step.percent,
      );
    }

    // Post-step smoke test
    if (step.requiresPostStepSmoke && inputs.smokeTest) {
      core.info(`[promotion] Waiting ${step.pauseAfterSeconds}s before verification`);
      await sleep(step.pauseAfterSeconds * 1000 + 5000); // extra 5s for propagation

      transition(lifecycle, 'smoke_tests_running');
      const smokeResult = await runSmokeTest(inputs.smokeTest, 'post-promotion');
      stepResult.smokeTest = smokeResult;

      if (!smokeResult.passed) {
        core.error(`[promotion] Smoke test failed at ${step.percent}% -- initiating recovery`);
        stepResult.success = false;
        result.stepResults.push(stepResult);

        return await handleFailure(
          inputs, result, lifecycle, previousStableVersionId,
          'post-promotion-smoke',
          `Smoke test failed at ${step.percent}%: ${smokeResult.failureReason || 'Unexpected failure'}`,
          true,
          step.percent,
        );
      }
    } else if (step.pauseAfterSeconds > 0) {
      core.info(`[promotion] Waiting ${step.pauseAfterSeconds}s before next step`);
      await sleep(step.pauseAfterSeconds * 1000);
    }

    result.stepResults.push(stepResult);
    core.info(`[promotion] Step ${i + 1}/${plan.steps.length} complete: ${step.percent}%`);
  }

  // ── Post-promotion verification ──
  if (inputs.smokeTest) {
    const postSmokeResult = await runPostPromotionSmokeTest(inputs, lifecycle);
    result.postPromotionSmokeResult = postSmokeResult;

    if (!postSmokeResult.passed) {
      return await handleFailure(
        inputs, result, lifecycle, previousStableVersionId,
        'post-promotion-smoke',
        `Post-promotion smoke test failed: ${postSmokeResult.failureReason || 'Unexpected failure'}`,
        true,
      );
    }

    transition(lifecycle, 'post_promotion_verified');
  }

  result.state = 'complete';
  result.promotionStatus = 'success';
  result.completedAt = timestamp();
  transition(lifecycle, 'promoted');
  return result;
}

// ─── Strategy: Staging-Only ──────────────────────────────

async function executeStagingOnly(
  inputs: ActionInputs,
  result: PromotionResult,
  lifecycle: LifecycleTracker,
  releaseContext?: ReleaseContext,
  _previousStableVersionId?: string,
): Promise<PromotionResult> {
  core.info('');
  core.info('='.repeat(50));
  core.info('  Phase 2: Deploying Candidate (staging-only)');
  core.info('='.repeat(50));
  core.notice('Strategy: staging-only -- candidate will be deployed and verified but NOT promoted to production traffic');

  const deployResult = await cloudflare.deployCandidate(inputs, releaseContext);
  result.deploy = deployResult;

  if (!deployResult.success) {
    result.state = 'failed';
    result.error = `Candidate deployment failed: ${deployResult.stderr}`;
    result.completedAt = timestamp();
    result.failure = {
      phase: 'candidate-deploy',
      reason: result.error,
      productionTrafficAffected: false,
      rollbackApplicable: false,
      rollbackAttempted: false,
    };
    result.promotionStatus = 'failed';
    transition(lifecycle, 'failed');
    core.info('[rollback] Staging-only deploy failed -- no production traffic affected, rollback not needed');
    return result;
  }

  transition(lifecycle, 'candidate_deployed');
  logCandidateSummary(deployResult, _previousStableVersionId);

  // Run candidate verification
  if (inputs.smokeTest) {
    const smokeResult = await runCandidateSmokeTest(inputs, lifecycle);
    result.candidateSmokeResult = smokeResult;

    if (!smokeResult.passed && inputs.smokeTest.required) {
      result.state = 'failed';
      result.error = `Candidate verification failed: ${smokeResult.failureReason}`;
      result.completedAt = timestamp();
      result.failure = {
        phase: 'candidate-smoke',
        reason: result.error,
        productionTrafficAffected: false, // staging-only, no prod traffic
        rollbackApplicable: false, // No production rollback needed
        rollbackAttempted: false,
      };
      result.promotionStatus = 'failed';
      transition(lifecycle, 'failed');
      core.info('[rollback] Staging-only smoke failure -- no production traffic affected');
      return result;
    }

    if (smokeResult.passed) {
      transition(lifecycle, 'candidate_verified');
    }
  }

  // Terminal state: candidate verified only
  result.state = 'staging-only';
  result.promotionStatus = 'staging-only';
  result.completedAt = timestamp();
  transition(lifecycle, 'candidate_verified_only');
  core.notice('Staging-only deployment complete. Candidate is ready for manual promotion.');
  return result;
}

// ─── Shared Helpers ──────────────────────────────────────

/**
 * Run candidate smoke tests (Phase 1 verification).
 */
async function runCandidateSmokeTest(
  inputs: ActionInputs,
  lifecycle: LifecycleTracker,
): Promise<import('./types').SmokeTestResult> {
  core.info('');
  core.info('='.repeat(50));
  core.info('  Candidate Verification (smoke tests)');
  core.info('='.repeat(50));

  transition(lifecycle, 'smoke_tests_running');

  // Wait for deployment to propagate
  core.info('[smoke-test] Waiting 5s for deployment propagation');
  await sleep(5000);

  return await runSmokeTest(inputs.smokeTest!, 'candidate');
}

/**
 * Run post-promotion smoke tests (Phase 2 verification).
 */
async function runPostPromotionSmokeTest(
  inputs: ActionInputs,
  lifecycle: LifecycleTracker,
): Promise<import('./types').SmokeTestResult> {
  core.info('');
  core.info('='.repeat(50));
  core.info('  Post-Promotion Verification (smoke tests)');
  core.info('='.repeat(50));

  transition(lifecycle, 'smoke_tests_running');

  // Wait for traffic shift to propagate
  core.info('[smoke-test] Waiting 5s for traffic propagation');
  await sleep(5000);

  return await runSmokeTest(inputs.smokeTest!, 'post-promotion');
}

/**
 * Handle promotion or smoke test failure with structured context and optional rollback.
 *
 * This is the central failure handler that:
 *  1. Creates a PromotionFailure with full context
 *  2. Decides whether rollback is applicable and enabled
 *  3. Performs rollback (if applicable)
 *  4. Runs post-rollback health check
 *  5. Sets granular PromotionStatus
 */
async function handleFailure(
  inputs: ActionInputs,
  result: PromotionResult,
  lifecycle: LifecycleTracker,
  previousStableVersionId: string | undefined,
  failurePhase: PromotionFailure['phase'],
  errorMessage: string,
  productionTrafficAffected: boolean,
  failedAtPercent?: number,
): Promise<PromotionResult> {
  const rollbackApplicable = !!previousStableVersionId && productionTrafficAffected;
  const rollbackEnabled = inputs.autoRollback;

  const failure: PromotionFailure = {
    phase: failurePhase,
    failedAtPercent,
    reason: errorMessage,
    productionTrafficAffected,
    rollbackApplicable,
    rollbackAttempted: false,
  };

  core.info('');
  core.info('-'.repeat(50));
  core.info('  Failure Analysis');
  core.info('-'.repeat(50));
  core.info(`  Phase:                 ${failurePhase}`);
  core.info(`  Reason:                ${errorMessage}`);
  core.info(`  Traffic affected:      ${productionTrafficAffected}`);
  core.info(`  Rollback applicable:   ${rollbackApplicable}`);
  core.info(`  Auto-rollback enabled: ${rollbackEnabled}`);
  if (failedAtPercent !== undefined) {
    core.info(`  Failed at percentage:  ${failedAtPercent}%`);
  }
  core.info('-'.repeat(50));

  // Decide rollback action
  if (rollbackApplicable && rollbackEnabled && previousStableVersionId) {
    // ── Perform rollback ──
    core.info('');
    core.info('='.repeat(50));
    core.info('  Recovery Phase: Automatic Rollback');
    core.info('='.repeat(50));
    core.info(`[rollback] Rolling back to stable version: ${previousStableVersionId}`);

    const rollbackResult = await performRollback(previousStableVersionId, inputs, lifecycle);
    result.rollback = rollbackResult;
    failure.rollbackAttempted = true;
    failure.rollbackSucceeded = rollbackResult.success;

    if (rollbackResult.success) {
      result.state = 'rolled-back';
      result.promotionStatus = 'failed-rollback-succeeded';
      core.info(`[rollback] Recovery successful -- production restored to ${previousStableVersionId}`);
    } else {
      result.state = 'failed';
      result.promotionStatus = 'failed-rollback-failed';
      core.error(`[rollback] CRITICAL: Rollback failed -- production state may be inconsistent`);
      core.error(`[rollback] Manual intervention required: restore version ${previousStableVersionId}`);
    }
  } else if (rollbackApplicable && !rollbackEnabled) {
    // ── Rollback applicable but disabled ──
    core.warning('[rollback] Rollback is applicable but auto-rollback is DISABLED');
    core.warning(`[rollback] To restore: manually deploy version ${previousStableVersionId}`);
    result.state = 'failed';
    result.promotionStatus = 'failed-rollback-disabled';
  } else if (!productionTrafficAffected) {
    // ── No production traffic was affected ──
    core.info('[rollback] No production traffic was affected -- rollback not needed');
    result.state = 'failed';
    result.promotionStatus = 'failed-no-rollback';
  } else {
    // ── No rollback target ──
    core.warning('[rollback] No previous stable version -- cannot rollback');
    result.state = 'failed';
    result.promotionStatus = 'failed-no-rollback';
  }

  result.failure = failure;
  result.error = errorMessage;
  result.completedAt = timestamp();
  return result;
}

/**
 * Perform rollback to a specific version with post-rollback health check.
 */
async function performRollback(
  versionId: string,
  inputs: ActionInputs,
  lifecycle: LifecycleTracker,
): Promise<RollbackResult> {
  transition(lifecycle, 'rollback_in_progress');

  const rollbackResult = await cloudflare.rollbackToVersion(versionId, inputs);

  // Post-rollback health check (if smoke tests are configured)
  if (rollbackResult.success && inputs.smokeTest && inputs.smokeTest.checks.length > 0) {
    core.info('[rollback] Running post-rollback health check');
    await sleep(5000); // Wait for rollback to propagate

    try {
      const healthResult = await runSmokeTest(inputs.smokeTest, 'post-promotion');
      rollbackResult.postRollbackHealthy = healthResult.passed;

      if (healthResult.passed) {
        core.info('[rollback] Post-rollback health check PASSED -- service is healthy');
      } else {
        core.error('[rollback] Post-rollback health check FAILED -- service may be unhealthy');
        core.error(`[rollback] Failure reason: ${healthResult.failureReason || 'Unknown'}`);
      }
    } catch (err) {
      core.warning(`[rollback] Post-rollback health check error: ${err instanceof Error ? err.message : String(err)}`);
      rollbackResult.postRollbackHealthy = undefined;
    }
  }

  if (rollbackResult.success) {
    transition(lifecycle, 'rolled_back');
  } else {
    transition(lifecycle, 'failed');
  }

  return rollbackResult;
}

/**
 * Log concise deployment summary for operator visibility.
 */
function logCandidateSummary(
  deploy: DeployResult,
  previousStableVersionId?: string,
): void {
  core.info('');
  core.info('--- Candidate Deployment Summary ----------------');
  core.info(`  Worker:            ${deploy.workerName || '(from config)'}`);
  core.info(`  Release Tag:       ${deploy.releaseTag || '(none)'}`);
  core.info(`  Version ID:        ${deploy.versionId || '(unknown)'}`);
  core.info(`  Deployment ID:     ${deploy.deploymentId || '(unknown)'}`);
  if (deploy.stagingUrl)    core.info(`  Staging URL:       ${deploy.stagingUrl}`);
  if (deploy.productionUrl) core.info(`  Production URL:    ${deploy.productionUrl}`);
  core.info(`  Git SHA:           ${deploy.gitSha || '(unknown)'}`);
  core.info(`  Git Ref:           ${deploy.gitRef || '(unknown)'}`);
  core.info(`  Source Trigger:    ${deploy.sourceTrigger || '(unknown)'}`);
  core.info(`  Deployed At:       ${deploy.deployedAt || '(unknown)'}`);
  if (previousStableVersionId) {
    core.info(`  Previous Stable:   ${previousStableVersionId}`);
  } else {
    core.info(`  Previous Stable:   (none -- first deployment)`);
  }
  core.info('-'.repeat(50));
  core.info('');
}
