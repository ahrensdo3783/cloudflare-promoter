// ─────────────────────────────────────────────────────────
// src/promotion.ts — Promotion plans, gradual rollout, state machine
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import {
  type ActionInputs,
  type PromotionPlan,
  type PromotionResult,
  type PromotionStepResult,
} from './types';
import * as cloudflare from './cloudflare';
import { runSmokeTest } from './smoke';
import { timestamp, sleep } from './utils';

/**
 * Build a promotion plan from action inputs.
 */
export function buildPromotionPlan(inputs: ActionInputs): PromotionPlan {
  return {
    steps: inputs.rolloutSteps,
    smokeTestEnabled: !!inputs.smokeTest,
    workerName: inputs.workerName,
    environment: inputs.environment,
  };
}

/**
 * Execute the full promotion flow:
 *
 *  1. Look up current stable version (rollback target)
 *  2. Upload new version
 *  3. For each rollout step:
 *     a. Promote to the step's percentage
 *     b. Run smoke tests (if enabled)
 *     c. On failure → rollback to stable
 *  4. Return the overall result
 */
export async function executePromotion(
  inputs: ActionInputs,
  plan: PromotionPlan,
): Promise<PromotionResult> {
  const result: PromotionResult = {
    state: 'pending',
    stepResults: [],
    startedAt: timestamp(),
  };

  try {
    // ── Step 1: Look up current stable version ──
    result.state = 'deploying';
    core.info('');
    core.info('═══════════════════════════════════════════');
    core.info('  Phase 1: Preparing Deployment');
    core.info('═══════════════════════════════════════════');

    const previousStableVersionId = await cloudflare.lookupCurrentStableVersion(inputs);
    result.previousStableVersionId = previousStableVersionId || undefined;

    // ── Step 2: Deploy / Upload ──
    if (plan.steps.length === 1 && plan.steps[0] === 100) {
      // Simple deployment — no gradual rollout needed
      core.info('');
      core.info('═══════════════════════════════════════════');
      core.info('  Phase 2: Deploying (immediate 100%)');
      core.info('═══════════════════════════════════════════');

      const deployResult = await cloudflare.deployCandidate(inputs);
      result.deploy = deployResult;

      if (!deployResult.success) {
        result.state = 'failed';
        result.error = `Deployment failed: ${deployResult.stderr}`;
        result.completedAt = timestamp();
        return result;
      }

      // Record the step result
      const stepResult: PromotionStepResult = {
        percentage: 100,
        success: true,
        message: `Deployed version ${deployResult.versionId || 'unknown'}`,
      };

      // ── Smoke test at 100% ──
      if (inputs.smokeTest) {
        result.state = 'smoke-testing';
        core.info('');
        core.info('═══════════════════════════════════════════');
        core.info('  Phase 3: Smoke Testing');
        core.info('═══════════════════════════════════════════');

        // Wait a moment for deployment to propagate
        core.info('⏳ Waiting 5s for deployment propagation…');
        await sleep(5000);

        const smokeResult = await runSmokeTest(inputs.smokeTest);
        stepResult.smokeTest = smokeResult;

        if (!smokeResult.passed) {
          core.error('❌ Smoke test failed — initiating rollback…');
          stepResult.success = false;
          result.stepResults.push(stepResult);

          // Rollback
          if (previousStableVersionId) {
            const rollbackResult = await cloudflare.rollbackToVersion(
              previousStableVersionId,
              inputs,
            );
            result.rollback = rollbackResult;
            result.state = 'rolled-back';
          } else {
            core.warning('⚠️ No previous version available for rollback.');
            result.state = 'failed';
          }

          result.error = `Smoke test failed: ${smokeResult.error || 'Unexpected failure'}`;
          result.completedAt = timestamp();
          return result;
        }
      }

      result.stepResults.push(stepResult);
      result.state = 'complete';
      result.completedAt = timestamp();
      return result;
    }

    // ── Gradual rollout ──
    core.info('');
    core.info('═══════════════════════════════════════════');
    core.info('  Phase 2: Uploading Version (Gradual Rollout)');
    core.info('═══════════════════════════════════════════');

    const newVersionId = await cloudflare.uploadVersion(inputs);

    // Give Cloudflare a moment to register the version
    await sleep(2000);

    // ── Step 3: Gradual promotion steps ──
    for (let i = 0; i < plan.steps.length; i++) {
      const pct = plan.steps[i]!;
      result.state = 'promoting';
      core.info('');
      core.info('═══════════════════════════════════════════');
      core.info(`  Phase ${3 + i}: Promoting to ${pct}% (step ${i + 1}/${plan.steps.length})`);
      core.info('═══════════════════════════════════════════');

      const stepResult = await cloudflare.promoteVersion(
        newVersionId,
        pct,
        inputs,
        previousStableVersionId,
      );

      // Smoke test after each step (if enabled and not the last step,
      // or always on the last step)
      if (inputs.smokeTest) {
        result.state = 'smoke-testing';
        core.info('⏳ Waiting 5s for traffic shift to propagate…');
        await sleep(5000);

        const smokeResult = await runSmokeTest(inputs.smokeTest);
        stepResult.smokeTest = smokeResult;

        if (!smokeResult.passed) {
          core.error(`❌ Smoke test failed at ${pct}% — initiating rollback…`);
          stepResult.success = false;
          result.stepResults.push(stepResult);

          // Rollback
          if (previousStableVersionId) {
            const rollbackResult = await cloudflare.rollbackToVersion(
              previousStableVersionId,
              inputs,
            );
            result.rollback = rollbackResult;
            result.state = 'rolled-back';
          } else {
            core.warning('⚠️ No previous version available for rollback.');
            result.state = 'failed';
          }

          result.error = `Smoke test failed at ${pct}%: ${smokeResult.error || 'Unexpected failure'}`;
          result.completedAt = timestamp();
          return result;
        }
      }

      if (!stepResult.success) {
        core.error(`❌ Promotion to ${pct}% failed — initiating rollback…`);
        result.stepResults.push(stepResult);

        if (previousStableVersionId) {
          const rollbackResult = await cloudflare.rollbackToVersion(
            previousStableVersionId,
            inputs,
          );
          result.rollback = rollbackResult;
          result.state = 'rolled-back';
        } else {
          result.state = 'failed';
        }

        result.error = `Promotion failed at ${pct}%: ${stepResult.message}`;
        result.completedAt = timestamp();
        return result;
      }

      result.stepResults.push(stepResult);
      core.info(`✅ Step ${i + 1}/${plan.steps.length} complete: ${pct}%`);
    }

    // Set deploy result from version upload info
    result.deploy = {
      success: true,
      versionId: newVersionId,
      stdout: '',
      stderr: '',
    };

    result.state = 'complete';
    result.completedAt = timestamp();
    return result;
  } catch (err) {
    result.state = 'failed';
    result.error = err instanceof Error ? err.message : String(err);
    result.completedAt = timestamp();

    // Attempt emergency rollback
    if (result.previousStableVersionId) {
      core.warning('⚠️ Unexpected error — attempting emergency rollback…');
      try {
        const rollbackResult = await cloudflare.rollbackToVersion(
          result.previousStableVersionId,
          inputs,
        );
        result.rollback = rollbackResult;
        result.state = 'rolled-back';
      } catch (rollbackErr) {
        core.error(
          `❌ Emergency rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
        );
      }
    }

    return result;
  }
}
