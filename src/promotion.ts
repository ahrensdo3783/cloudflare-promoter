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
  type PromotionPlan,
  type PromotionResult,
  type PromotionStep,
  type PromotionStepResult,
  type ReleaseContext,
} from './types';
import * as cloudflare from './cloudflare';
import { runSmokeTest } from './smoke';
import { timestamp, sleep, formatDuration } from './utils';

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
 *     c. On failure -> rollback to stable
 *  6. Run post-promotion verification (if enabled)
 *  7. Return the overall result
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
    result.state = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
    result.completedAt = timestamp();

    // Attempt emergency rollback
    if (result.previousStableVersionId) {
      core.warning('[promotion] Unexpected error -- attempting emergency rollback');
      transition(lifecycle, 'rollback_in_progress');
      try {
        const rollbackResult = await cloudflare.rollbackToVersion(
          result.previousStableVersionId,
          inputs,
        );
        result.rollback = rollbackResult;
        result.state = 'rolled-back';
        transition(lifecycle, 'rolled_back');
      } catch (rollbackErr) {
        core.error(
          `[promotion] Emergency rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        );
        transition(lifecycle, 'failed');
      }
    } else {
      transition(lifecycle, 'failed');
    }

    return result;
  }
}

// ─── Strategy: Immediate ─────────────────────────────────

async function executeImmediate(
  inputs: ActionInputs,
  plan: PromotionPlan,
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
    transition(lifecycle, 'failed');
    return result;
  }

  transition(lifecycle, 'candidate_deployed');
  logCandidateSummary(deployResult, previousStableVersionId);

  // ── Candidate smoke test ──
  if (inputs.smokeTest) {
    const smokeResult = await runCandidateSmokeTest(inputs, lifecycle, deployResult);
    result.candidateSmokeResult = smokeResult;

    if (!smokeResult.passed) {
      result.stepResults.push({
        percentage: 100,
        success: false,
        message: `Candidate smoke test failed: ${smokeResult.failureReason}`,
        smokeTest: smokeResult,
      });

      return await handleSmokeFailure(
        inputs, result, lifecycle, previousStableVersionId,
        `Candidate smoke test failed: ${smokeResult.failureReason || 'Unexpected failure'}`,
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
    const postSmokeResult = await runPostPromotionSmokeTest(inputs, lifecycle, deployResult);
    result.postPromotionSmokeResult = postSmokeResult;

    if (!postSmokeResult.passed) {
      return await handleSmokeFailure(
        inputs, result, lifecycle, previousStableVersionId,
        `Post-promotion smoke test failed: ${postSmokeResult.failureReason || 'Unexpected failure'}`,
      );
    }

    transition(lifecycle, 'post_promotion_verified');
  }

  result.state = 'complete';
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
    const smokeResult = await runCandidateSmokeTest(inputs, lifecycle, result.deploy);
    result.candidateSmokeResult = smokeResult;

    if (!smokeResult.passed) {
      return await handleSmokeFailure(
        inputs, result, lifecycle, previousStableVersionId,
        `Candidate smoke test failed before gradual rollout: ${smokeResult.failureReason || 'Unexpected failure'}`,
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
      core.error(`[promotion] Step failed at ${step.percent}% -- initiating rollback`);
      result.stepResults.push(stepResult);

      return await handleSmokeFailure(
        inputs, result, lifecycle, previousStableVersionId,
        `Promotion failed at ${step.percent}%: ${stepResult.message}`,
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
        core.error(`[promotion] Smoke test failed at ${step.percent}% -- initiating rollback`);
        stepResult.success = false;
        result.stepResults.push(stepResult);

        return await handleSmokeFailure(
          inputs, result, lifecycle, previousStableVersionId,
          `Smoke test failed at ${step.percent}%: ${smokeResult.failureReason || 'Unexpected failure'}`,
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
    const postSmokeResult = await runPostPromotionSmokeTest(inputs, lifecycle, result.deploy);
    result.postPromotionSmokeResult = postSmokeResult;

    if (!postSmokeResult.passed) {
      return await handleSmokeFailure(
        inputs, result, lifecycle, previousStableVersionId,
        `Post-promotion smoke test failed: ${postSmokeResult.failureReason || 'Unexpected failure'}`,
      );
    }

    transition(lifecycle, 'post_promotion_verified');
  }

  result.state = 'complete';
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
  previousStableVersionId?: string,
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
    transition(lifecycle, 'failed');
    return result;
  }

  transition(lifecycle, 'candidate_deployed');
  logCandidateSummary(deployResult, previousStableVersionId);

  // Run candidate verification
  if (inputs.smokeTest) {
    const smokeResult = await runCandidateSmokeTest(inputs, lifecycle, deployResult);
    result.candidateSmokeResult = smokeResult;

    if (!smokeResult.passed && inputs.smokeTest.required) {
      result.state = 'failed';
      result.error = `Candidate verification failed: ${smokeResult.failureReason}`;
      result.completedAt = timestamp();
      transition(lifecycle, 'failed');
      return result;
    }

    if (smokeResult.passed) {
      transition(lifecycle, 'candidate_verified');
    }
  }

  // Terminal state: candidate verified only
  result.state = 'staging-only';
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
  deploy: DeployResult,
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
  deploy: DeployResult,
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
 * Handle smoke test or promotion failure with rollback.
 */
async function handleSmokeFailure(
  inputs: ActionInputs,
  result: PromotionResult,
  lifecycle: LifecycleTracker,
  previousStableVersionId?: string,
  errorMessage?: string,
): Promise<PromotionResult> {
  if (previousStableVersionId) {
    transition(lifecycle, 'rollback_in_progress');
    const rollbackResult = await cloudflare.rollbackToVersion(
      previousStableVersionId,
      inputs,
    );
    result.rollback = rollbackResult;
    result.state = 'rolled-back';
    transition(lifecycle, 'rolled_back');
  } else {
    core.warning('[promotion] No previous version available for rollback');
    result.state = 'failed';
    transition(lifecycle, 'failed');
  }

  result.error = errorMessage || 'Verification failed';
  result.completedAt = timestamp();
  return result;
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
