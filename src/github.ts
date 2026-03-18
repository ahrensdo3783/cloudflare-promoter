// ─────────────────────────────────────────────────────────
// src/github.ts — GitHub event resolution and API operations
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  type ReleaseContext,
  type ReleaseNotesSection,
  type ReleaseNoteMode,
  ActionError,
  ErrorCode,
} from './types';

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

  // Fallback for non-release events (workflow_dispatch, push, PR, etc.)
  if (
    eventName === 'workflow_dispatch' ||
    eventName === 'push' ||
    eventName === 'merge_group' ||
    eventName === 'pull_request' ||
    eventName === 'pull_request_target'
  ) {
    const pseudoTag =
      eventName === 'pull_request' || eventName === 'pull_request_target'
        ? `pr-${(payload.pull_request?.number as number | undefined) || 'unknown'}`
        : context.ref.replace('refs/tags/', '').replace('refs/heads/', '');

    core.warning(
      `Event "${eventName}" does not provide a release payload. ` +
        'Using ref/SHA as pseudo-release context.',
    );
    return {
      id: 0,
      tagName: pseudoTag,
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
      'This action supports: release, workflow_dispatch, push, merge_group, pull_request, pull_request_target.',
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
  mode: ReleaseNoteMode,
  deploymentSectionHeading: string,
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
    const { data: currentRelease } = await octokit.rest.repos.getRelease({
      owner: releaseContext.owner,
      repo: releaseContext.repo,
      release_id: releaseContext.id,
    });

    const currentBody = currentRelease.body || '';

    // Build the deployment section markdown
    const sectionMd = renderDeploymentMarkdown(section, deploymentSectionHeading);
    const updatedBody = mergeReleaseBody(
      currentBody,
      sectionMd,
      mode,
      deploymentSectionHeading,
    );

    await octokit.rest.repos.updateRelease({
      owner: releaseContext.owner,
      repo: releaseContext.repo,
      release_id: releaseContext.id,
      body: updatedBody,
    });

    core.info(`[github] Release notes updated (${mode}) under heading "${deploymentSectionHeading}"`);
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

export function renderDeploymentMarkdown(
  section: ReleaseNotesSection,
  heading: string,
): string {
  const normalizedHeading = normalizeHeading(heading);
  const lines: string[] = [];
  lines.push(`## ${normalizedHeading}`);
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| ----- | ----- |');
  lines.push(`| Worker name | ${tableCode(section.workerName)} |`);
  lines.push(`| Release tag | ${tableCode(section.releaseTag)} |`);
  lines.push(
    `| Release ID | ${tableCode(section.releaseId !== undefined ? String(section.releaseId) : undefined)} |`,
  );
  lines.push(
    `| Candidate version ID | ${tableCode(section.candidateVersionId || section.versionId)} |`,
  );
  lines.push(`| Deployment ID | ${tableCode(section.deploymentId)} |`);
  lines.push(`| Staging URL | ${tableUrl(section.stagingUrl)} |`);
  lines.push(`| Production URL | ${tableUrl(section.productionUrl)} |`);
  lines.push(`| Promotion strategy | ${tableCode(section.promotionStrategy)} |`);
  lines.push(`| Smoke test result | ${tableCode(section.smokeTestStatus)} |`);
  lines.push(`| Promotion result | ${tableCode(section.promotionResult)} |`);
  lines.push(`| Rollback information | ${tableText(section.rollbackInformation)} |`);
  lines.push(`| Timestamp | ${tableCode(section.timestamp)} |`);
  lines.push(`| GitHub workflow run | ${tableUrl(section.workflowRunUrl)} |`);

  lines.push(`| Environment | ${tableCode(section.environment)} |`);
  if (section.url) {
    lines.push(`| Deployment URL | ${tableUrl(section.url)} |`);
  }
  if (section.rolloutSteps) {
    lines.push(`| Rollout steps | ${tableText(section.rolloutSteps)} |`);
  }
  if (section.previousStableVersionId) {
    lines.push(`| Previous stable version | ${tableCode(section.previousStableVersionId)} |`);
  }
  if (section.rollbackVersionId) {
    lines.push(`| Rollback version ID | ${tableCode(section.rollbackVersionId)} |`);
  }
  if (section.rollbackSucceeded !== undefined) {
    lines.push(
      `| Rollback succeeded | ${tableCode(section.rollbackSucceeded ? 'true' : 'false')} |`,
    );
  }
  if (section.postRollbackHealthy !== undefined) {
    lines.push(
      `| Post-rollback healthy | ${tableCode(section.postRollbackHealthy ? 'true' : 'false')} |`,
    );
  }
  if (section.failurePhase) {
    lines.push(`| Failure phase | ${tableCode(section.failurePhase)} |`);
  }
  if (section.gitSha) {
    lines.push(`| Git SHA | ${tableCode(section.gitSha.substring(0, 12))} |`);
  }
  if (section.sourceTrigger) {
    lines.push(`| Source trigger | ${tableCode(section.sourceTrigger)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

export function mergeReleaseBody(
  currentBody: string,
  sectionMarkdown: string,
  mode: ReleaseNoteMode,
  heading: string,
): string {
  if (mode === 'append') {
    return appendMarkdownBlock(currentBody, sectionMarkdown);
  }

  const startMarker = buildSectionStartMarker(heading);
  const endMarker = buildSectionEndMarker(heading);
  const wrapped = `${startMarker}\n${sectionMarkdown}\n${endMarker}`;

  if (currentBody.includes(startMarker) && currentBody.includes(endMarker)) {
    const regex = new RegExp(
      `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
      'g',
    );
    return currentBody.replace(regex, wrapped);
  }

  const legacyStartMarker = '<!-- workers-release-promoter -->';
  const legacyEndMarker = '<!-- /workers-release-promoter -->';
  if (currentBody.includes(legacyStartMarker) && currentBody.includes(legacyEndMarker)) {
    const legacyRegex = new RegExp(
      `${escapeRegExp(legacyStartMarker)}[\\s\\S]*?${escapeRegExp(legacyEndMarker)}`,
      'g',
    );
    return currentBody.replace(legacyRegex, wrapped);
  }

  return appendMarkdownBlock(currentBody, wrapped);
}

function normalizeHeading(heading: string): string {
  const normalized = heading.trim().replace(/^#{1,6}\s*/, '').trim();
  return normalized || 'Workers Production Promotion';
}

function appendMarkdownBlock(currentBody: string, block: string): string {
  const trimmed = currentBody.trimEnd();
  if (!trimmed) {
    return block;
  }
  return `${trimmed}\n\n${block}`;
}

function buildSectionStartMarker(heading: string): string {
  return `<!-- workers-release-promoter:${slugifyHeading(heading)}:start -->`;
}

function buildSectionEndMarker(heading: string): string {
  return `<!-- workers-release-promoter:${slugifyHeading(heading)}:end -->`;
}

function slugifyHeading(heading: string): string {
  const slug = normalizeHeading(heading)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'workers-production-promotion';
}

function tableCode(value?: string): string {
  if (!value) return 'n/a';
  return `\`${escapeTableValue(value)}\``;
}

function tableText(value?: string): string {
  if (!value) return 'n/a';
  return escapeTableValue(value);
}

function tableUrl(value?: string): string {
  if (!value) return 'n/a';
  const escaped = escapeTableValue(value);
  return `[${escaped}](${escaped})`;
}

function escapeTableValue(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
