// ─────────────────────────────────────────────────────────
// src/github.ts — GitHub event resolution and API operations
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import * as github from '@actions/github';
import { type ReleaseContext, type ReleaseNotesSection, ActionError, ErrorCode } from './types';

/**
 * Resolve release context from the GitHub event payload.
 * Primarily supports `release.published`, with graceful fallback info
 * for other event types (workflow_dispatch, push, etc.).
 */
export function resolveReleaseContext(): ReleaseContext {
  const { context } = github;
  const { eventName, payload } = context;

  core.info(`[github] Resolving release context from event: ${eventName}`);

  if (eventName === 'release' && payload.release) {
    const release = payload.release;
    return {
      id: release.id as number,
      tagName: release.tag_name as string,
      name: (release.name as string) || release.tag_name as string,
      body: (release.body as string) || '',
      prerelease: release.prerelease as boolean,
      draft: release.draft as boolean,
      htmlUrl: release.html_url as string,
      owner: context.repo.owner,
      repo: context.repo.repo,
      targetCommitish: (release.target_commitish as string) || context.sha,
    };
  }

  // Fallback for non-release events (workflow_dispatch, push, etc.)
  if (eventName === 'workflow_dispatch' || eventName === 'push' || eventName === 'merge_group') {
    core.warning(
      `Event "${eventName}" does not provide a release payload. ` +
        'Using ref/SHA as pseudo-release context.',
    );
    return {
      id: 0,
      tagName: context.ref.replace('refs/tags/', '').replace('refs/heads/', ''),
      name: `Deployment from ${eventName}`,
      body: '',
      prerelease: false,
      draft: false,
      htmlUrl: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
      owner: context.repo.owner,
      repo: context.repo.repo,
      targetCommitish: context.sha,
    };
  }

  throw new ActionError(
    ErrorCode.MISSING_RELEASE_CONTEXT,
    `Unsupported event type "${eventName}". ` +
      'This action supports: release, workflow_dispatch, push, merge_group.',
  );
}

/**
 * Update the body of a GitHub Release with deployment information.
 * Uses idempotent section markers so re-runs replace instead of duplicate.
 */
export async function updateReleaseBody(
  releaseContext: ReleaseContext,
  section: ReleaseNotesSection,
  githubToken: string,
): Promise<void> {
  if (!githubToken) {
    core.warning('No GitHub token provided -- skipping release notes update.');
    return;
  }

  if (releaseContext.id === 0) {
    core.info('[github] Skipping release notes update (no GitHub Release associated)');
    return;
  }

  try {
    const octokit = github.getOctokit(githubToken);

    // Build the deployment section markdown
    const sectionMd = buildDeploymentMarkdown(section);

    // Replace or append the section in the release body
    const marker = '<!-- workers-release-promoter -->';
    const markerEnd = '<!-- /workers-release-promoter -->';
    let updatedBody: string;

    if (releaseContext.body.includes(marker)) {
      // Replace existing section
      const regex = new RegExp(
        `${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(markerEnd)}`,
        'g',
      );
      updatedBody = releaseContext.body.replace(regex, `${marker}\n${sectionMd}\n${markerEnd}`);
    } else {
      // Append new section
      updatedBody = `${releaseContext.body}\n\n${marker}\n${sectionMd}\n${markerEnd}`;
    }

    await octokit.rest.repos.updateRelease({
      owner: releaseContext.owner,
      repo: releaseContext.repo,
      release_id: releaseContext.id,
      body: updatedBody,
    });

    core.info('[github] Release notes updated with deployment information');
  } catch (err) {
    core.warning(
      `Failed to update release notes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Create a GitHub deployment status for the current deployment.
 */
export async function createDeploymentStatus(
  releaseContext: ReleaseContext,
  state: 'success' | 'failure' | 'in_progress',
  environmentName: string,
  deploymentUrl: string | undefined,
  githubToken: string,
): Promise<void> {
  if (!githubToken) {
    core.warning('No GitHub token provided -- skipping deployment status.');
    return;
  }

  try {
    const octokit = github.getOctokit(githubToken);

    // Create a deployment
    const { data: deployment } = await octokit.rest.repos.createDeployment({
      owner: releaseContext.owner,
      repo: releaseContext.repo,
      ref: releaseContext.targetCommitish,
      environment: environmentName,
      auto_merge: false,
      required_contexts: [],
      description: `Workers deployment via release ${releaseContext.tagName}`,
    });

    if ('id' in deployment) {
      // Create deployment status
      await octokit.rest.repos.createDeploymentStatus({
        owner: releaseContext.owner,
        repo: releaseContext.repo,
        deployment_id: deployment.id,
        state,
        environment_url: deploymentUrl,
        description: `Cloudflare Workers ${state}`,
      });

      core.info(`[github] Deployment status created: ${state}`);
    }
  } catch (err) {
    core.warning(
      `Failed to create deployment status: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Internal Helpers ────────────────────────────────────

function buildDeploymentMarkdown(section: ReleaseNotesSection): string {
  const lines: string[] = [];
  lines.push('### Cloudflare Workers Deployment');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`| ----- | ----- |`);
  lines.push(`| **Environment** | \`${section.environment}\` |`);

  const resultLabel =
    section.promotionResult === 'success'
      ? 'Success'
      : section.promotionResult === 'staging-only'
        ? 'Staging-Only'
        : section.promotionResult === 'rolled-back'
          ? 'Rolled Back'
          : 'Failed';
  lines.push(`| **Result** | ${resultLabel} |`);

  if (section.promotionStrategy) {
    lines.push(`| **Strategy** | \`${section.promotionStrategy}\` |`);
  }
  if (section.releaseTag) {
    lines.push(`| **Release** | \`${section.releaseTag}\` |`);
  }
  if (section.deploymentId) {
    lines.push(`| **Deployment ID** | \`${section.deploymentId}\` |`);
  }
  if (section.versionId) {
    lines.push(`| **Version ID** | \`${section.versionId}\` |`);
  }
  if (section.stagingUrl) {
    lines.push(`| **Staging URL** | ${section.stagingUrl} |`);
  }
  if (section.productionUrl) {
    lines.push(`| **Production URL** | ${section.productionUrl} |`);
  } else if (section.url) {
    lines.push(`| **URL** | ${section.url} |`);
  }
  if (section.gitSha) {
    lines.push(`| **Git SHA** | \`${section.gitSha.substring(0, 12)}\` |`);
  }
  if (section.smokeTestPassed !== undefined) {
    lines.push(`| **Smoke Test** | ${section.smokeTestPassed ? 'Passed' : 'Failed'} |`);
  }
  if (section.rollbackTriggered) {
    lines.push(`| **Rollback** | Triggered |`);
    if (section.rollbackVersionId) {
      lines.push(`| **Rollback Version** | \`${section.rollbackVersionId}\` |`);
    }
  }
  if (section.previousStableVersionId) {
    lines.push(`| **Previous Stable** | \`${section.previousStableVersionId}\` |`);
  }
  if (section.rolloutSteps) {
    lines.push(`| **Rollout** | ${section.rolloutSteps} |`);
  }
  lines.push(`| **Timestamp** | ${section.timestamp} |`);

  return lines.join('\n');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
