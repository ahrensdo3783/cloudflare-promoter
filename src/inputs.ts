// ─────────────────────────────────────────────────────────
// src/inputs.ts — Parse, normalize, and validate action inputs
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import {
  type ActionInputs,
  type CloudflareAuth,
  type SmokeTestConfig,
  ActionError,
  ErrorCode,
} from './types';
import { maskSecret, parsePercentages } from './utils';

/**
 * Resolve Cloudflare authentication from explicit inputs or environment variables.
 * Explicit inputs win over environment variables.
 */
function resolveAuth(): CloudflareAuth {
  const apiToken =
    core.getInput('cloudflare-api-token', { required: false }) ||
    process.env['CLOUDFLARE_API_TOKEN'] ||
    '';

  const accountId =
    core.getInput('cloudflare-account-id', { required: false }) ||
    process.env['CLOUDFLARE_ACCOUNT_ID'] ||
    '';

  if (!apiToken) {
    throw new ActionError(
      ErrorCode.MISSING_API_TOKEN,
      'Cloudflare API token is required. Provide it via the "cloudflare-api-token" input or the CLOUDFLARE_API_TOKEN environment variable.',
    );
  }

  if (!accountId) {
    throw new ActionError(
      ErrorCode.MISSING_ACCOUNT_ID,
      'Cloudflare account ID is required. Provide it via the "cloudflare-account-id" input or the CLOUDFLARE_ACCOUNT_ID environment variable.',
    );
  }

  // Mask secrets so they never appear in logs
  maskSecret(apiToken);
  maskSecret(accountId);

  return { apiToken, accountId };
}

/**
 * Resolve smoke test configuration from inputs.
 * Returns undefined if no smoke-test-url is provided (smoke testing disabled).
 */
function resolveSmokeTest(): SmokeTestConfig | undefined {
  const url = core.getInput('smoke-test-url', { required: false });
  if (!url) return undefined;

  const expectedStatus = parseInt(
    core.getInput('smoke-test-expected-status') || '200',
    10,
  );
  if (isNaN(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
    throw new ActionError(
      ErrorCode.INVALID_INPUT,
      `Invalid smoke-test-expected-status: must be a valid HTTP status code (100-599).`,
    );
  }

  const expectedBodyContains =
    core.getInput('smoke-test-expected-body-contains', { required: false }) || undefined;

  const timeoutMs = parseInt(core.getInput('smoke-test-timeout') || '10000', 10);
  if (isNaN(timeoutMs) || timeoutMs < 1000) {
    throw new ActionError(
      ErrorCode.INVALID_INPUT,
      'Invalid smoke-test-timeout: must be at least 1000 (1 second).',
    );
  }

  const retries = parseInt(core.getInput('smoke-test-retries') || '3', 10);
  if (isNaN(retries) || retries < 0 || retries > 10) {
    throw new ActionError(
      ErrorCode.INVALID_INPUT,
      'Invalid smoke-test-retries: must be between 0 and 10.',
    );
  }

  return {
    url,
    expectedStatus,
    expectedBodyContains,
    timeoutMs,
    retries,
  };
}

/**
 * Parse, normalize, and validate all action inputs.
 * Fails fast with descriptive error messages.
 */
export function getInputs(): ActionInputs {
  core.info('📥 Parsing action inputs…');

  // Auth (fail early if missing)
  const auth = resolveAuth();
  core.info('✅ Cloudflare authentication resolved');

  // Worker configuration
  const workerName = core.getInput('worker-name', { required: false }) || undefined;
  const workingDirectory = core.getInput('working-directory') || '.';
  const environment = core.getInput('environment') || 'production';

  // Smoke test
  const smokeTest = resolveSmokeTest();
  if (smokeTest) {
    core.info(`✅ Smoke test configured: ${smokeTest.url}`);
  } else {
    core.info('ℹ️  Smoke testing disabled (no smoke-test-url provided)');
  }

  // Rollout
  const rolloutInput = core.getInput('rollout-percentage') || '100';
  let rolloutSteps: number[];
  try {
    rolloutSteps = parsePercentages(rolloutInput);
  } catch (err) {
    throw new ActionError(
      ErrorCode.INVALID_INPUT,
      `Invalid rollout-percentage: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  core.info(`✅ Rollout steps: ${rolloutSteps.join('% → ')}%`);

  // Dry run
  const dryRunInput = core.getInput('dry-run') || 'false';
  const dryRun = dryRunInput.toLowerCase() === 'true';
  if (dryRun) {
    core.info('🔍 Dry-run mode enabled — no deployments will be made');
  }

  // GitHub token
  const githubToken = core.getInput('github-token') || process.env['GITHUB_TOKEN'] || '';

  return {
    auth,
    workerName,
    workingDirectory,
    environment,
    smokeTest,
    rolloutSteps,
    dryRun,
    githubToken,
  };
}
