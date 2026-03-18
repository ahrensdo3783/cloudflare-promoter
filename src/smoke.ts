// ─────────────────────────────────────────────────────────
// src/smoke.ts — Fetch-based smoke test engine + custom command
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import {
  type SmokeTestConfig,
  type SmokeTestResult,
  type SmokeCheckResult,
  type SmokeCheckDefinition,
  ActionError,
  ErrorCode,
} from './types';
import { retry, formatDuration, truncate, timestamp } from './utils';

/**
 * Run the full smoke test suite against the deployed Worker.
 *
 * Supports:
 *  - Multiple endpoint checks via native fetch (Node 20)
 *  - Custom command execution
 *  - Configurable retries, timeouts, and total deadline
 *  - Two-phase verification (candidate vs post-promotion)
 */
export async function runSmokeTest(
  config: SmokeTestConfig,
  phase: 'candidate' | 'post-promotion' = 'candidate',
): Promise<SmokeTestResult> {
  const startTime = Date.now();
  const startedAt = timestamp();
  const checkResults: SmokeCheckResult[] = [];
  let rawCommandOutput: string | undefined;
  let overallPassed = true;
  let failureReason: string | undefined;

  core.info(`[smoke-test] Starting ${phase} verification (${config.checks.length} check(s))`);

  // Set a total deadline
  const deadline = startTime + config.deadlineMs;

  try {
    // Run fetch-based checks
    for (const check of config.checks) {
      if (Date.now() >= deadline) {
        failureReason = `Total smoke test deadline exceeded (${formatDuration(config.deadlineMs)})`;
        overallPassed = false;
        break;
      }

      const result = await runSingleCheck(check, config.retries, config.retryIntervalMs, deadline);
      checkResults.push(result);

      if (!result.passed) {
        overallPassed = false;
        failureReason = `Check "${result.name}" failed: ${result.error || 'unknown error'}`;
        if (config.required) break; // Stop on first required failure
      }
    }

    // Run custom command if provided
    if (config.customCommand && overallPassed && Date.now() < deadline) {
      core.info(`[smoke-test] Running custom command: ${config.customCommand}`);
      const cmdResult = await runCustomCommand(config.customCommand);
      rawCommandOutput = cmdResult.output;

      if (!cmdResult.success) {
        overallPassed = false;
        failureReason = `Custom smoke command failed: ${cmdResult.error}`;
      } else {
        core.info('[smoke-test] Custom command passed');
      }
    }
  } catch (err) {
    overallPassed = false;
    failureReason = err instanceof Error ? err.message : String(err);
  }

  const finishedAt = timestamp();
  const durationMs = Date.now() - startTime;

  const status = overallPassed ? 'passed' : 'failed';
  core.info(`[smoke-test] ${phase} verification ${status} (${formatDuration(durationMs)})`);

  if (!overallPassed && failureReason) {
    core.error(`[smoke-test] Failure: ${failureReason}`);
  }

  return {
    status,
    passed: overallPassed,
    checks: checkResults,
    rawCommandOutput,
    startedAt,
    finishedAt,
    durationMs,
    failureReason,
    phase,
  };
}

/**
 * Execute a single smoke check with retries.
 */
async function runSingleCheck(
  check: SmokeCheckDefinition,
  retries: number,
  retryIntervalMs: number,
  deadline: number,
): Promise<SmokeCheckResult> {
  core.info(`[smoke-test] Check "${check.name}": ${check.method} ${check.url}`);
  core.info(`[smoke-test]   Expected: status=${check.expectedStatus}, timeout=${formatDuration(check.timeoutMs)}`);

  if (check.expectedBodyIncludes) {
    core.info(`[smoke-test]   Expected body contains: "${truncate(check.expectedBodyIncludes, 80)}"`);
  }

  let totalAttempts = 0;

  try {
    const result = await retry(
      async (): Promise<SmokeCheckResult> => {
        totalAttempts++;

        if (Date.now() >= deadline) {
          throw new ActionError(ErrorCode.SMOKE_TEST_TIMEOUT, 'Deadline exceeded');
        }

        return executeSingleFetch(check, totalAttempts);
      },
      retries,
      retryIntervalMs,
      `smoke:${check.name}`,
    );
    return result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    core.error(`[smoke-test] Check "${check.name}" failed after ${totalAttempts} attempt(s): ${errorMessage}`);

    return {
      name: check.name,
      passed: false,
      latencyMs: 0,
      error: errorMessage,
      attempts: totalAttempts,
    };
  }
}

/**
 * Execute a single fetch request for a smoke check.
 */
async function executeSingleFetch(
  check: SmokeCheckDefinition,
  attempt: number,
): Promise<SmokeCheckResult> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), check.timeoutMs);

  try {
    const response = await fetch(check.url, {
      method: check.method,
      signal: controller.signal,
      headers: {
        ...check.headers,
        Accept: 'text/html,application/json,*/*',
      },
    });

    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    const body = await response.text();

    core.info(
      `[smoke-test]   Attempt ${attempt}: status=${response.status}, ` +
        `latency=${formatDuration(latencyMs)}, body=${truncate(body, 100).replace(/\n/g, ' ')}`,
    );

    // Check status code
    const statusMatch = response.status === check.expectedStatus;
    if (!statusMatch) {
      throw new ActionError(
        ErrorCode.SMOKE_TEST_FAILED,
        `Expected status ${check.expectedStatus}, got ${response.status}`,
      );
    }

    // Check body contains (if configured)
    let bodyMatch: boolean | undefined;
    if (check.expectedBodyIncludes) {
      bodyMatch = body.includes(check.expectedBodyIncludes);
      if (!bodyMatch) {
        throw new ActionError(
          ErrorCode.SMOKE_TEST_FAILED,
          `Response body does not contain expected string "${truncate(check.expectedBodyIncludes, 50)}"`,
        );
      }
    }

    core.info(`[smoke-test]   PASS (attempt ${attempt}, ${formatDuration(latencyMs)})`);

    return {
      name: check.name,
      passed: true,
      statusCode: response.status,
      bodyMatch,
      latencyMs,
      bodySnippet: truncate(body, 500),
      attempts: attempt,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof ActionError) throw err;

    if (err instanceof Error && err.name === 'AbortError') {
      throw new ActionError(
        ErrorCode.SMOKE_TEST_TIMEOUT,
        `Smoke test timed out after ${formatDuration(check.timeoutMs)}`,
        err,
      );
    }

    throw new ActionError(
      ErrorCode.SMOKE_TEST_FAILED,
      `Smoke test request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

/**
 * Run a custom smoke test command via subprocess.
 */
async function runCustomCommand(
  command: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const execaMod = await import('execa');
    const execa = execaMod.default ?? execaMod;
    const result = await execa('sh', ['-c', command], {
      reject: false,
      timeout: 120_000,
    });

    const output = `${result.stdout}\n${result.stderr}`.trim();

    if (result.exitCode !== 0) {
      return {
        success: false,
        output,
        error: `Command exited with code ${result.exitCode}: ${result.stderr || result.stdout}`,
      };
    }

    return { success: true, output };
  } catch (err) {
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
