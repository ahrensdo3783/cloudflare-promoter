// ─────────────────────────────────────────────────────────
// src/index.ts — Orchestration entrypoint for workers-release-promoter
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import * as github from '@actions/github';
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
 *  4. If dry-run -> validate & print plan, exit
 *  5. Execute promotion flow (deploy -> smoke -> promote -> rollback if needed)
 *  6. Annotate release page with deployment info
 *  7. Set outputs & write job summary
 */
async function run(): Promise<void> {
  const startTime = Date.now();

  try {
    // ── 1. Parse Inputs ──
    core.info('');
    core.info('='.repeat(50));
    core.info('  Workers Release Promoter');
    core.info('='.repeat(50));
    core.info('');

    const inputs = getInputs();

    // ── 2. Resolve Release Context ──
    const releaseContext = resolveReleaseContext();
    const serverUrl = process.env['GITHUB_SERVER_URL'] || 'https://github.com';
    const runId = github.context.runId ? String(github.context.runId) : process.env['GITHUB_RUN_ID'];
    const workflowRunUrl = runId
      ? `${serverUrl}/${releaseContext.owner}/${releaseContext.repo}/actions/runs/${runId}`
      : '';
    core.info(`[release] Tag: ${releaseContext.tagName} -- ${releaseContext.name}`);
    if (releaseContext.prerelease) {
      core.notice('This is a pre-release.');
    }

    // ── 3. Validate Wrangler ──
    await ensureWrangler(inputs);

    // ── 4. Dry Run ──
    if (inputs.dryRun) {
      core.info('');
      core.info('='.repeat(50));
      core.info('  DRY RUN -- Validation Only');
      core.info('='.repeat(50));
      core.info('');

      const plan = buildPromotionPlan(inputs);
      core.info('[ok] Inputs validated successfully');
      core.info(`[ok] Release context resolved: ${releaseContext.tagName}`);
      core.info('[ok] Wrangler is available');
      core.info(`[ok] Worker: ${inputs.workerName || '(from config)'}`);
      core.info(`[ok] Environment: ${inputs.environment}`);
      core.info(`[ok] Strategy: ${inputs.promotionStrategy}`);
      if (plan.steps.length > 0) {
        core.info(`[ok] Rollout plan: ${plan.steps.map(s => `${s.percent}%`).join(' -> ')}`);
      }
      core.info(`[ok] Smoke tests: ${plan.smokeTestEnabled ? 'enabled' : 'disabled'}`);
      core.info('');
      core.notice('Dry run complete -- no deployments were made');

      // Set outputs for dry run
      core.setOutput('release-tag', releaseContext.tagName);
      core.setOutput('release-id', String(releaseContext.id));
      core.setOutput('release-url', releaseContext.htmlUrl || '');
      core.setOutput('workflow-run-url', workflowRunUrl);
      core.setOutput('environment', inputs.environment);
      core.setOutput('promotion-strategy', inputs.promotionStrategy);
      core.setOutput('promotion-result', 'dry-run');
      core.setOutput('promotion-status', 'dry-run');
      core.setOutput('rollback-triggered', 'false');
      core.setOutput('rollback-version-id', '');
      core.setOutput('rollback-succeeded', '');
      core.setOutput('post-rollback-healthy', '');
      core.setOutput('smoke-test-passed', '');
      core.setOutput('smoke-test-status', 'skipped');
      core.setOutput('deployment-id', '');
      core.setOutput('worker-version-id', '');
      core.setOutput('candidate-version-id', '');
      core.setOutput('worker-name', inputs.workerName || '');
      core.setOutput('previous-stable-version-id', '');
      core.setOutput('deployment-url', '');
      core.setOutput('staging-url', '');
      core.setOutput('production-url', '');
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
    core.info(`[plan] Strategy: ${plan.strategy}`);
    if (plan.steps.length > 0) {
      core.info(`[plan] Steps: ${plan.steps.map(s => `${s.percent}%`).join(' -> ')}`);
    }
    core.info(`[plan] Smoke tests: ${plan.smokeTestEnabled ? 'enabled' : 'disabled'}`);
    core.info('');

    const result = await executePromotion(inputs, plan, releaseContext);

    // ── 7. Set Outputs ──
    // Release context
    core.setOutput('release-tag', releaseContext.tagName);
    core.setOutput('release-id', String(releaseContext.id));
    core.setOutput('release-url', releaseContext.htmlUrl || '');
    core.setOutput('workflow-run-url', workflowRunUrl);
    core.setOutput('environment', inputs.environment);
    core.setOutput('promotion-strategy', inputs.promotionStrategy);

    // Deployment metadata
    core.setOutput('worker-name', result.deploy?.workerName || inputs.workerName || '');
    core.setOutput('deployment-id', result.deploy?.deploymentId || '');
    core.setOutput('worker-version-id', result.deploy?.versionId || '');
    core.setOutput('candidate-version-id', result.deploy?.versionId || '');
    core.setOutput('deployment-url', result.deploy?.url || '');
    core.setOutput('staging-url', result.deploy?.stagingUrl || '');
    core.setOutput('production-url', result.deploy?.productionUrl || '');
    core.setOutput('previous-stable-version-id', result.previousStableVersionId || '');
    // Backward compat alias
    core.setOutput('version-id', result.deploy?.versionId || '');

    // Rollback
    core.setOutput('rollback-triggered', String(result.rollback?.attempted || false));
    core.setOutput('rollback-version-id', result.rollback?.rolledBackToVersionId || '');
    core.setOutput(
      'rollback-succeeded',
      result.rollback?.attempted ? String(result.rollback.success) : '',
    );
    core.setOutput('post-rollback-healthy', result.rollback?.postRollbackHealthy !== undefined
      ? String(result.rollback.postRollbackHealthy)
      : '');

    // Promotion status (granular)
    const promotionStatus = result.promotionStatus || 'failed';
    core.setOutput('promotion-result', promotionStatus);
    core.setOutput('promotion-status', promotionStatus);

    // Smoke test status
    let smokeTestPassed = '';
    let smokeTestStatus = 'skipped';

    if (result.candidateSmokeResult) {
      smokeTestPassed = String(result.candidateSmokeResult.passed);
      smokeTestStatus = result.candidateSmokeResult.passed ? 'passed' : 'failed';
    }
    if (result.postPromotionSmokeResult) {
      smokeTestPassed = String(result.postPromotionSmokeResult.passed);
      smokeTestStatus = result.postPromotionSmokeResult.passed ? 'passed' : 'failed';
    }
    // Also check step-level smoke results
    for (const step of result.stepResults) {
      if (step.smokeTest) {
        smokeTestPassed = String(step.smokeTest.passed);
        smokeTestStatus = step.smokeTest.passed ? 'passed' : 'failed';
        if (!step.smokeTest.passed) break;
      }
    }
    core.setOutput('smoke-test-passed', smokeTestPassed);
    core.setOutput('smoke-test-status', smokeTestStatus);

    // ── 8. Update Release Notes ──
    const notesSection = buildReleaseNotesSection(
      result,
      {
        environment: inputs.environment,
        promotionStrategy: inputs.promotionStrategy,
        rolloutSteps: inputs.rolloutSteps,
        releaseTag: releaseContext.tagName,
        releaseId: releaseContext.id,
        workerName: inputs.workerName,
        workflowRunUrl: workflowRunUrl || undefined,
      },
    );
    await updateReleaseBody(
      releaseContext,
      notesSection,
      inputs.githubToken,
      inputs.releaseNoteMode,
      inputs.deploymentSectionHeading,
    );

    // ── 9. Update GitHub Deployment Status ──
    const deployState =
      result.state === 'complete' || result.state === 'staging-only'
        ? 'success'
        : 'failure';
    await createDeploymentStatus(
      releaseContext,
      deployState,
      inputs.environment,
      result.deploy?.url,
      inputs.githubToken,
    );

    // ── 10. Write Job Summary ──
    const summary = buildJobSummary(
      result,
      inputs.environment,
      releaseContext.tagName,
      inputs.promotionStrategy,
    );
    await core.summary.addRaw(summary).write();

    // ── 11. Final Status ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    core.info('');
    core.info('='.repeat(50));

    if (result.state === 'complete') {
      core.info(`  [success] Promotion complete in ${elapsed}s`);
      core.info('='.repeat(50));
    } else if (result.state === 'staging-only') {
      core.info(`  [staging-only] Candidate deployed and verified in ${elapsed}s`);
      core.info('='.repeat(50));
    } else if (result.state === 'rolled-back') {
      core.info(`  [rolled-back] Promotion failed, rolled back in ${elapsed}s`);
      core.info('='.repeat(50));

      // Build informative failure message
      const failMsg = [
        `Release ${releaseContext.tagName}`,
        result.deploy?.versionId ? `deployed candidate version ${result.deploy.versionId}` : undefined,
        result.failure?.phase ? `failed during phase: ${result.failure.phase}` : undefined,
        result.failure?.failedAtPercent !== undefined ? `at ${result.failure.failedAtPercent}% traffic` : undefined,
        result.rollback?.rolledBackToVersionId ? `rollback to version ${result.rollback.rolledBackToVersionId} succeeded` : undefined,
        result.rollback?.rolledBackAt ? `at ${result.rollback.rolledBackAt}` : undefined,
      ].filter(Boolean).join(', ');

      core.setFailed(failMsg);
    } else {
      core.info(`  [failed] Promotion failed after ${elapsed}s`);
      core.info('='.repeat(50));

      // Distinguish failure modes
      if (result.promotionStatus === 'failed-rollback-failed') {
        core.error('CRITICAL: Rollback also failed -- manual intervention required');
      } else if (result.promotionStatus === 'failed-rollback-disabled') {
        core.warning('Auto-rollback was disabled. Manual rollback may be needed.');
      }

      const failMsg = [
        `Deployment failed: ${result.error || 'Unknown error'}`,
        result.promotionStatus ? `(status: ${result.promotionStatus})` : undefined,
      ].filter(Boolean).join(' ');

      core.setFailed(failMsg);
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

    core.info(`[timing] Failed after ${elapsed}s`);
  }
}

// Run the action
run();
