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
      if (!smokeTestPassed) break; // One failure is enough
    }
  }

  return {
    deploymentId: result.deploy?.deploymentId,
    versionId: result.deploy?.versionId,
    url: result.deploy?.url,
    smokeTestPassed,
    promotionResult: result.state === 'complete'
      ? 'success'
      : result.state === 'rolled-back'
        ? 'rolled-back'
        : 'failed',
    rollbackTriggered: result.state === 'rolled-back',
    timestamp: result.completedAt || timestamp(),
    environment,
    rolloutSteps: rolloutSteps ? rolloutSteps.map((s) => `${s}%`).join(' → ') : undefined,
  };
}

/**
 * Build the deployment summary markdown for the GitHub Actions job summary.
 */
export function buildJobSummary(
  result: PromotionResult,
  environment: string,
  tagName?: string,
): string {
  const lines: string[] = [];

  // Header
  lines.push('# 🚀 Workers Release Promoter');
  lines.push('');

  // Status badge
  const statusEmoji =
    result.state === 'complete'
      ? '✅'
      : result.state === 'rolled-back'
        ? '⚠️'
        : '❌';
  const statusText =
    result.state === 'complete'
      ? 'Deployment Successful'
      : result.state === 'rolled-back'
        ? 'Rolled Back'
        : 'Deployment Failed';
  lines.push(`## ${statusEmoji} ${statusText}`);
  lines.push('');

  // Summary table
  lines.push('| Property | Value |');
  lines.push('| -------- | ----- |');
  if (tagName) {
    lines.push(`| **Release** | \`${tagName}\` |`);
  }
  lines.push(`| **Environment** | \`${environment}\` |`);
  lines.push(`| **Status** | ${statusText} |`);

  if (result.deploy?.versionId) {
    lines.push(`| **Version ID** | \`${result.deploy.versionId}\` |`);
  }
  if (result.deploy?.deploymentId) {
    lines.push(`| **Deployment ID** | \`${result.deploy.deploymentId}\` |`);
  }
  if (result.deploy?.url) {
    lines.push(`| **URL** | ${result.deploy.url} |`);
  }
  lines.push(`| **Started** | ${result.startedAt} |`);
  if (result.completedAt) {
    lines.push(`| **Completed** | ${result.completedAt} |`);
  }
  lines.push('');

  // Rollout steps
  if (result.stepResults.length > 0) {
    lines.push('### 📊 Rollout Steps');
    lines.push('');
    lines.push('| Step | Percentage | Status | Smoke Test |');
    lines.push('| ---- | ---------- | ------ | ---------- |');
    result.stepResults.forEach((step, i) => {
      const stepStatus = step.success ? '✅ OK' : '❌ Failed';
      let smokeCol = '—';
      if (step.smokeTest) {
        smokeCol = step.smokeTest.passed
          ? `✅ ${step.smokeTest.latencyMs}ms`
          : `❌ ${step.smokeTest.error || 'Failed'}`;
      }
      lines.push(`| ${i + 1} | ${step.percentage}% | ${stepStatus} | ${smokeCol} |`);
    });
    lines.push('');
  }

  // Rollback info
  if (result.rollback) {
    lines.push('### ⏪ Rollback');
    lines.push('');
    lines.push(
      result.rollback.success
        ? `✅ Successfully rolled back to version \`${result.rollback.rolledBackToVersionId}\``
        : `❌ Rollback failed: ${result.rollback.message}`,
    );
    lines.push('');
  }

  // Error
  if (result.error) {
    lines.push('### ❌ Error');
    lines.push('');
    lines.push(`\`\`\`\n${result.error}\n\`\`\``);
    lines.push('');
  }

  return lines.join('\n');
}
