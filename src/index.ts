// ─────────────────────────────────────────────────────────
// src/index.ts — Orchestration entrypoint for workers-release-promoter
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import { getInputs } from './inputs';
import { resolveReleaseContext, updateReleaseBody, createDeploymentStatus } from './github';
import { ensureWrangler } from './cloudflare';
import { buildPromotionPlan, executePromotion } from './promotion';
import { buildReleaseNotesSection, buildJobSummary } from './releaseNotes';
import { ActionError } from './types';

/**
 * Main action entrypoint.
 *
 * Orchestration flow:
 *  1. Parse + validate inputs
 *  2. Resolve release context from GitHub event
 *  3. Validate Cloudflare/Wrangler environment
 *  4. If dry-run → validate & print plan, exit
 *  5. Execute promotion flow (deploy → smoke → promote → rollback if needed)
 *  6. Annotate release page with deployment info
 *  7. Set outputs & write job summary
 */
async function run(): Promise<void> {
  const startTime = Date.now();

  try {
    // ── 1. Parse Inputs ──
    core.info('');
    core.info('╔═══════════════════════════════════════════╗');
    core.info('║   Workers Release Promoter v1.0.0        ║');
    core.info('╚═══════════════════════════════════════════╝');
    core.info('');

    const inputs = getInputs();

    // ── 2. Resolve Release Context ──
    const releaseContext = resolveReleaseContext();
    core.info(`📦 Release: ${releaseContext.tagName} — ${releaseContext.name}`);
    if (releaseContext.prerelease) {
      core.info('⚠️  This is a pre-release.');
    }

    // ── 3. Validate Wrangler ──
    await ensureWrangler(inputs);

    // ── 4. Dry Run ──
    if (inputs.dryRun) {
      core.info('');
      core.info('═══════════════════════════════════════════');
      core.info('  DRY RUN — Validation Only');
      core.info('═══════════════════════════════════════════');
      core.info('');

      const plan = buildPromotionPlan(inputs);
      core.info('✅ Inputs validated successfully');
      core.info(`✅ Release context resolved: ${releaseContext.tagName}`);
      core.info(`✅ Wrangler is available`);
      core.info(`✅ Worker: ${inputs.workerName || '(from config)'}`);
      core.info(`✅ Environment: ${inputs.environment}`);
      core.info(`✅ Rollout plan: ${plan.steps.join('% → ')}%`);
      core.info(`✅ Smoke tests: ${plan.smokeTestEnabled ? 'enabled' : 'disabled'}`);
      core.info('');
      core.info('🔍 Dry run complete — no deployments were made.');

      // Set outputs for dry run
      core.setOutput('promotion-result', 'dry-run');
      core.setOutput('rollback-triggered', 'false');
      core.setOutput('smoke-test-passed', '');
      return;
    }

    // ── 5. Create GitHub deployment (in_progress) ──
    await createDeploymentStatus(
      releaseContext,
      'in_progress',
      inputs.environment,
      undefined,
      inputs.githubToken,
    );

    // ── 6. Execute Promotion ──
    const plan = buildPromotionPlan(inputs);
    core.info('');
    core.info(`📋 Promotion plan: ${plan.steps.join('% → ')}%`);
    core.info(`   Smoke tests: ${plan.smokeTestEnabled ? '✅ enabled' : '⏭️  disabled'}`);
    core.info('');

    const result = await executePromotion(inputs, plan);

    // ── 7. Set Outputs ──
    core.setOutput('deployment-id', result.deploy?.deploymentId || '');
    core.setOutput('version-id', result.deploy?.versionId || '');
    core.setOutput('deployment-url', result.deploy?.url || '');
    core.setOutput('rollback-triggered', String(result.state === 'rolled-back'));
    core.setOutput(
      'promotion-result',
      result.state === 'complete'
        ? 'success'
        : result.state === 'rolled-back'
          ? 'rolled-back'
          : 'failed',
    );

    // Determine smoke test output
    let smokeTestPassed = '';
    for (const step of result.stepResults) {
      if (step.smokeTest) {
        smokeTestPassed = String(step.smokeTest.passed);
        if (!step.smokeTest.passed) break;
      }
    }
    core.setOutput('smoke-test-passed', smokeTestPassed);

    // ── 8. Update Release Notes ──
    const notesSection = buildReleaseNotesSection(
      result,
      inputs.environment,
      inputs.rolloutSteps,
    );
    await updateReleaseBody(releaseContext, notesSection, inputs.githubToken);

    // ── 9. Update GitHub Deployment Status ──
    const deployState = result.state === 'complete' ? 'success' : 'failure';
    await createDeploymentStatus(
      releaseContext,
      deployState,
      inputs.environment,
      result.deploy?.url,
      inputs.githubToken,
    );

    // ── 10. Write Job Summary ──
    const summary = buildJobSummary(result, inputs.environment, releaseContext.tagName);
    await core.summary.addRaw(summary).write();

    // ── 11. Final Status ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    core.info('');
    core.info('═══════════════════════════════════════════');

    if (result.state === 'complete') {
      core.info(`  ✅ Promotion complete in ${elapsed}s`);
      core.info('═══════════════════════════════════════════');
    } else if (result.state === 'rolled-back') {
      core.info(`  ⚠️  Promotion rolled back after ${elapsed}s`);
      core.info('═══════════════════════════════════════════');
      core.setFailed(`Deployment rolled back: ${result.error || 'Unknown error'}`);
    } else {
      core.info(`  ❌ Promotion failed after ${elapsed}s`);
      core.info('═══════════════════════════════════════════');
      core.setFailed(`Deployment failed: ${result.error || 'Unknown error'}`);
    }
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (err instanceof ActionError) {
      core.error(`[${err.code}] ${err.message}`);
      core.setFailed(`${err.code}: ${err.message}`);
    } else {
      core.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
      core.setFailed(err instanceof Error ? err.message : String(err));
    }

    core.info(`⏱️  Failed after ${elapsed}s`);
  }
}

// Run the action
run();
