// ─────────────────────────────────────────────────────────
// src/inputs.ts — Parse, normalize, and validate action inputs
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import {
  type ActionInputs,
  type CloudflareAuth,
  type SmokeTestConfig,
  type SmokeCheckDefinition,
  type PromotionStrategy,
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

  maskSecret(apiToken);
  maskSecret(accountId);

  return { apiToken, accountId };
}

/**
 * Resolve smoke test configuration from inputs.
 * Returns undefined if no smoke-test-url is provided and no custom command.
 */
function resolveSmokeTest(): SmokeTestConfig | undefined {
  const url = core.getInput('smoke-test-url', { required: false });
  const customCommand = core.getInput('smoke-test-command', { required: false }) || undefined;
  const requiredInput = core.getInput('smoke-test-required', { required: false }) || 'true';
  const required = requiredInput.toLowerCase() !== 'false';

  if (!url && !customCommand) return undefined;

  const checks: SmokeCheckDefinition[] = [];

  if (url) {
    const expectedStatus = parseInt(
      core.getInput('smoke-test-expected-status') || '200',
      10,
    );
    if (isNaN(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) {
      throw new ActionError(
        ErrorCode.INVALID_INPUT,
        'Invalid smoke-test-expected-status: must be a valid HTTP status code (100-599).',
      );
    }

    const expectedBodyIncludes =
      core.getInput('smoke-test-expected-body-contains', { required: false }) || undefined;

    const timeoutMs = parseInt(core.getInput('smoke-test-timeout') || '10000', 10);
    if (isNaN(timeoutMs) || timeoutMs < 1000) {
      throw new ActionError(
        ErrorCode.INVALID_INPUT,
        'Invalid smoke-test-timeout: must be at least 1000 (1 second).',
      );
    }

    // Build primary check
    checks.push({
      name: 'primary',
      url,
      method: 'GET',
      headers: { 'User-Agent': 'workers-release-promoter/1.0 (smoke-test)' },
      expectedStatus,
      expectedBodyIncludes,
      timeoutMs,
    });

    // Parse additional paths if provided
    const additionalPaths = core.getInput('smoke-test-paths', { required: false });
    if (additionalPaths) {
      const baseUrl = new URL(url);
      const paths = additionalPaths.split(',').map((p) => p.trim()).filter(Boolean);
      for (const path of paths) {
        const checkUrl = new URL(path, baseUrl.origin).toString();
        checks.push({
          name: path,
          url: checkUrl,
          method: 'GET',
          headers: { 'User-Agent': 'workers-release-promoter/1.0 (smoke-test)' },
          expectedStatus,
          expectedBodyIncludes: undefined,
          timeoutMs,
        });
      }
    }
  }

  const retries = parseInt(core.getInput('smoke-test-retries') || '3', 10);
  if (isNaN(retries) || retries < 0 || retries > 10) {
    throw new ActionError(
      ErrorCode.INVALID_INPUT,
      'Invalid smoke-test-retries: must be between 0 and 10.',
    );
  }

  const retryIntervalMs = parseInt(
    core.getInput('smoke-test-retry-interval') || '2000',
    10,
  );
  const deadlineMs = parseInt(
    core.getInput('smoke-test-deadline') || '120000',
    10,
  );

  return {
    checks,
    retries,
    retryIntervalMs,
    deadlineMs,
    required,
    customCommand,
  };
}

/**
 * Parse, normalize, and validate all action inputs.
 * Fails fast with descriptive error messages.
 */
export function getInputs(): ActionInputs {
  core.info('[inputs] Parsing action inputs');

  // Auth (fail early if missing)
  const auth = resolveAuth();
  core.info('[inputs] Cloudflare authentication resolved');

  // Worker configuration
  const workerName = core.getInput('worker-name', { required: false }) || undefined;
  const workingDirectory = core.getInput('working-directory') || '.';
  const environment = core.getInput('environment') || 'production';

  // Smoke test
  const smokeTest = resolveSmokeTest();
  if (smokeTest) {
    core.info(`[inputs] Smoke test configured: ${smokeTest.checks.length} check(s), required=${smokeTest.required}`);
    if (smokeTest.customCommand) {
      core.info(`[inputs] Custom smoke command: ${smokeTest.customCommand}`);
    }
  } else {
    core.info('[inputs] Smoke testing disabled (no URL or command provided)');
  }

  // Promotion strategy
  const strategyInput = (core.getInput('promotion-strategy') || 'immediate').toLowerCase();
  let promotionStrategy: PromotionStrategy;
  if (strategyInput === 'immediate' || strategyInput === 'gradual' || strategyInput === 'staging-only') {
    promotionStrategy = strategyInput;
  } else {
    throw new ActionError(
      ErrorCode.INVALID_INPUT,
      `Invalid promotion-strategy: "${strategyInput}". Must be one of: immediate, gradual, staging-only.`,
    );
  }

  // Rollout steps
  let rolloutSteps: number[];
  if (promotionStrategy === 'gradual') {
    const rolloutInput = core.getInput('gradual-steps') || core.getInput('rollout-percentage') || '10,50,100';
    try {
      rolloutSteps = parsePercentages(rolloutInput);
    } catch (err) {
      throw new ActionError(
        ErrorCode.INVALID_INPUT,
        `Invalid gradual-steps: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (promotionStrategy === 'staging-only') {
    rolloutSteps = []; // No production steps
  } else {
    rolloutSteps = [100]; // Immediate
  }

  const gradualStepWaitSeconds = parseInt(
    core.getInput('gradual-step-wait-seconds') || '5',
    10,
  );
  const postStepSmokeTests = (core.getInput('post-step-smoke-tests') || 'true').toLowerCase() === 'true';

  core.info(`[inputs] Strategy: ${promotionStrategy}`);
  if (promotionStrategy === 'gradual') {
    core.info(`[inputs] Rollout steps: ${rolloutSteps.join('% -> ')}%`);
    core.info(`[inputs] Step wait: ${gradualStepWaitSeconds}s, post-step smoke: ${postStepSmokeTests}`);
  }

  // Auto-rollback
  const autoRollbackInput = core.getInput('auto-rollback') || 'true';
  const autoRollback = autoRollbackInput.toLowerCase() !== 'false';
  if (!autoRollback) {
    core.warning('[inputs] Automatic rollback is DISABLED -- failures will not trigger version restoration');
  }

  // Dry run
  const dryRunInput = core.getInput('dry-run') || 'false';
  const dryRun = dryRunInput.toLowerCase() === 'true';
  if (dryRun) {
    core.notice('Dry-run mode enabled -- no deployments will be made');
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
    promotionStrategy,
    gradualStepWaitSeconds,
    postStepSmokeTests,
    autoRollback,
    dryRun,
    githubToken,
  };
}
