// ─────────────────────────────────────────────────────────
// src/releaseNotes.ts — Markdown generation and section management
// ─────────────────────────────────────────────────────────

import { type ReleaseNotesSection, type PromotionResult } from './types';
import { timestamp } from './utils';

/**
 * Build a ReleaseNotesSection from a PromotionResult and deployment context.
 */
export function buildReleaseNotesSection(
  result: PromotionResult,
  environment: string,
  rolloutSteps?: number[],
): ReleaseNotesSection {
  let smokeTestPassed: boolean | undefined;

  // Determine smoke test outcome from step results
  for (const step of result.stepResults) {
    if (step.smokeTest) {
      smokeTestPassed = step.smokeTest.passed;
      if (!smokeTestPassed) break;
    }
  }

  // Also check candidate/post-promotion smoke results
  if (smokeTestPassed === undefined && result.candidateSmokeResult) {
    smokeTestPassed = result.candidateSmokeResult.passed;
  }
  if (smokeTestPassed !== false && result.postPromotionSmokeResult) {
    smokeTestPassed = result.postPromotionSmokeResult.passed;
  }

  const promotionResult = result.state === 'complete'
    ? 'success'
    : result.state === 'staging-only'
      ? 'staging-only'
      : result.state === 'rolled-back'
        ? 'rolled-back'
        : 'failed';

  return {
    deploymentId: result.deploy?.deploymentId,
    versionId: result.deploy?.versionId,
    url: result.deploy?.url,
    stagingUrl: result.deploy?.stagingUrl,
    productionUrl: result.deploy?.productionUrl,
    smokeTestPassed,
    promotionResult,
    promotionStrategy: result.deploy ? (result.state === 'staging-only' ? 'staging-only' : undefined) : undefined,
    rollbackTriggered: result.state === 'rolled-back',
    rollbackVersionId: result.rollback?.rolledBackToVersionId,
    releaseTag: result.deploy?.releaseTag,
    gitSha: result.deploy?.gitSha,
    sourceTrigger: result.deploy?.sourceTrigger,
    timestamp: result.completedAt || timestamp(),
    environment,
    rolloutSteps: rolloutSteps ? rolloutSteps.map((s) => `${s}%`).join(' -> ') : undefined,
    previousStableVersionId: result.previousStableVersionId,
  };
}

/**
 * Build the deployment summary markdown for the GitHub Actions job summary.
 */
export function buildJobSummary(
  result: PromotionResult,
  environment: string,
  tagName?: string,
  strategy?: string,
): string {
  const lines: string[] = [];

  // Header
  lines.push('# Workers Release Promoter');
  lines.push('');

  // Status
  const statusText =
    result.state === 'complete'
      ? 'Deployment Successful'
      : result.state === 'staging-only'
        ? 'Staging-Only Complete'
        : result.state === 'rolled-back'
          ? 'Rolled Back'
          : 'Deployment Failed';
  lines.push(`## ${statusText}`);
  lines.push('');

  // Summary table
  lines.push('| Property | Value |');
  lines.push('| -------- | ----- |');
  if (tagName) {
    lines.push(`| **Release** | \`${tagName}\` |`);
  }
  lines.push(`| **Environment** | \`${environment}\` |`);
  if (strategy) {
    lines.push(`| **Strategy** | \`${strategy}\` |`);
  }
  lines.push(`| **Status** | ${statusText} |`);

  if (result.deploy?.versionId) {
    lines.push(`| **Version ID** | \`${result.deploy.versionId}\` |`);
  }
  if (result.deploy?.deploymentId) {
    lines.push(`| **Deployment ID** | \`${result.deploy.deploymentId}\` |`);
  }
  if (result.deploy?.stagingUrl) {
    lines.push(`| **Staging URL** | ${result.deploy.stagingUrl} |`);
  }
  if (result.deploy?.productionUrl) {
    lines.push(`| **Production URL** | ${result.deploy.productionUrl} |`);
  } else if (result.deploy?.url) {
    lines.push(`| **URL** | ${result.deploy.url} |`);
  }
  if (result.deploy?.gitSha) {
    lines.push(`| **Git SHA** | \`${result.deploy.gitSha.substring(0, 12)}\` |`);
  }
  if (result.deploy?.sourceTrigger) {
    lines.push(`| **Trigger** | \`${result.deploy.sourceTrigger}\` |`);
  }
  if (result.previousStableVersionId) {
    lines.push(`| **Previous Stable** | \`${result.previousStableVersionId}\` |`);
  }
  lines.push(`| **Started** | ${result.startedAt} |`);
  if (result.completedAt) {
    lines.push(`| **Completed** | ${result.completedAt} |`);
  }
  lines.push('');

  // Rollout steps
  if (result.stepResults.length > 0) {
    lines.push('### Rollout Steps');
    lines.push('');
    lines.push('| Step | Percentage | Status | Smoke Test |');
    lines.push('| ---- | ---------- | ------ | ---------- |');
    result.stepResults.forEach((step, i) => {
      const stepStatus = step.success ? 'OK' : 'Failed';
      let smokeCol = '--';
      if (step.smokeTest) {
        smokeCol = step.smokeTest.passed
          ? `Passed (${step.smokeTest.durationMs}ms)`
          : `Failed: ${step.smokeTest.failureReason || 'Unknown'}`;
      }
      lines.push(`| ${i + 1} | ${step.percentage}% | ${stepStatus} | ${smokeCol} |`);
    });
    lines.push('');
  }

  // Candidate verification
  if (result.candidateSmokeResult) {
    lines.push('### Candidate Verification');
    lines.push('');
    lines.push(`Status: **${result.candidateSmokeResult.status}** (${result.candidateSmokeResult.durationMs}ms)`);
    if (result.candidateSmokeResult.checks.length > 0) {
      lines.push('');
      lines.push('| Check | Status | Latency | Details |');
      lines.push('| ----- | ------ | ------- | ------- |');
      for (const check of result.candidateSmokeResult.checks) {
        lines.push(`| ${check.name} | ${check.passed ? 'Passed' : 'Failed'} | ${check.latencyMs}ms | ${check.error || `Status ${check.statusCode}`} |`);
      }
    }
    lines.push('');
  }

  // Post-promotion verification
  if (result.postPromotionSmokeResult) {
    lines.push('### Post-Promotion Verification');
    lines.push('');
    lines.push(`Status: **${result.postPromotionSmokeResult.status}** (${result.postPromotionSmokeResult.durationMs}ms)`);
    lines.push('');
  }

  // Rollback info
  if (result.rollback) {
    lines.push('### Rollback');
    lines.push('');
    lines.push(
      result.rollback.success
        ? `Rolled back to version \`${result.rollback.rolledBackToVersionId}\``
        : `Rollback failed: ${result.rollback.message}`,
    );
    lines.push('');
  }

  // Error
  if (result.error) {
    lines.push('### Error');
    lines.push('');
    lines.push(`\`\`\`\n${result.error}\n\`\`\``);
    lines.push('');
  }

  // Lifecycle history
  if (result.lifecycle && result.lifecycle.history.length > 0) {
    lines.push('### Deployment Lifecycle');
    lines.push('');
    lines.push('| State | Timestamp |');
    lines.push('| ----- | --------- |');
    for (const entry of result.lifecycle.history) {
      lines.push(`| \`${entry.state}\` | ${entry.timestamp} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
