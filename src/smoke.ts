// ─────────────────────────────────────────────────────────
// src/smoke.ts — Fetch-based smoke test engine
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import { type SmokeTestConfig, type SmokeTestResult, ActionError, ErrorCode } from './types';
import { retry, formatDuration, truncate } from './utils';

/**
 * Run a smoke test against the deployed Worker.
 *
 * Uses Node 20 native fetch (no extra HTTP dependencies).
 * Supports: expected status, body-contains check, timeout, retries with backoff.
 */
export async function runSmokeTest(config: SmokeTestConfig): Promise<SmokeTestResult> {
  core.info(`🧪 Running smoke test: ${config.url}`);
  core.info(
    `   Expected status: ${config.expectedStatus}, ` +
      `timeout: ${formatDuration(config.timeoutMs)}, ` +
      `retries: ${config.retries}`,
  );

  if (config.expectedBodyContains) {
    core.info(`   Expected body contains: "${truncate(config.expectedBodyContains, 80)}"`);
  }

  let totalAttempts = 0;

  try {
    const result = await retry(
      async (): Promise<SmokeTestResult> => {
        totalAttempts++;
        return executeSingleSmokeTest(config, totalAttempts);
      },
      config.retries,
      2000, // initial delay: 2s
      'Smoke test',
    );
    return result;
  } catch (err) {
    // All retries exhausted
    const errorMessage = err instanceof Error ? err.message : String(err);
    core.error(`❌ Smoke test failed after ${totalAttempts} attempt(s): ${errorMessage}`);

    return {
      passed: false,
      latencyMs: 0,
      error: errorMessage,
      attempts: totalAttempts,
    };
  }
}

/**
 * Execute a single smoke test attempt.
 */
async function executeSingleSmokeTest(
  config: SmokeTestConfig,
  attempt: number,
): Promise<SmokeTestResult> {
  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'workers-release-promoter/1.0 (smoke-test)',
        Accept: 'text/html,application/json,*/*',
      },
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const body = await response.text();

    core.info(
      `   Attempt ${attempt}: status=${response.status}, ` +
        `latency=${formatDuration(latencyMs)}, ` +
        `body=${truncate(body, 100).replace(/\n/g, ' ')}`,
    );

    // Check status code
    const statusMatch = response.status === config.expectedStatus;
    if (!statusMatch) {
      throw new ActionError(
        ErrorCode.SMOKE_TEST_FAILED,
        `Expected status ${config.expectedStatus}, got ${response.status}`,
      );
    }

    // Check body contains (if configured)
    let bodyMatch: boolean | undefined;
    if (config.expectedBodyContains) {
      bodyMatch = body.includes(config.expectedBodyContains);
      if (!bodyMatch) {
        throw new ActionError(
          ErrorCode.SMOKE_TEST_FAILED,
          `Response body does not contain expected string "${truncate(config.expectedBodyContains, 50)}"`,
        );
      }
    }

    core.info(`   ✅ Smoke test passed (attempt ${attempt}, ${formatDuration(latencyMs)})`);

    return {
      passed: true,
      statusCode: response.status,
      bodyMatch,
      latencyMs,
      bodySnippet: truncate(body, 500),
      attempts: attempt,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;

    if (err instanceof ActionError) throw err;

    // Handle timeout specifically
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ActionError(
        ErrorCode.SMOKE_TEST_TIMEOUT,
        `Smoke test timed out after ${formatDuration(config.timeoutMs)}`,
        err,
      );
    }

    throw new ActionError(
      ErrorCode.SMOKE_TEST_FAILED,
      `Smoke test request failed: ${err instanceof Error ? err.message : String(err)} (${formatDuration(latencyMs)})`,
      err,
    );
  }
}
