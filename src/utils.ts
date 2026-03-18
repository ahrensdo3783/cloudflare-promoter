// ─────────────────────────────────────────────────────────
// src/utils.ts — Helpers: sleep, retry, timestamps, masking
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  retries: number,
  delayMs: number = 1000,
  label: string = 'operation',
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt <= retries) {
        const wait = delayMs * Math.pow(2, attempt - 1);
        core.warning(`${label} failed (attempt ${attempt}/${retries + 1}), retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
  }

  throw lastError;
}

/**
 * Returns an ISO-8601 timestamp string for the current moment.
 */
export function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Mask a secret value in GitHub Actions logs.
 */
export function maskSecret(value: string): void {
  if (value && value.length > 0) {
    core.setSecret(value);
  }
}

/**
 * Parse a comma-separated string of integers into a number array.
 * E.g., "10,50,100" -> [10, 50, 100]
 */
export function parsePercentages(input: string): number[] {
  const raw = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const result: number[] = [];
  for (const s of raw) {
    const n = parseInt(s, 10);
    if (isNaN(n) || n < 1 || n > 100) {
      throw new Error(`Invalid rollout percentage "${s}": must be an integer between 1 and 100`);
    }
    result.push(n);
  }

  if (result.length === 0) {
    throw new Error('Rollout percentages must contain at least one value');
  }

  // Ensure the last step is 100
  if (result[result.length - 1] !== 100) {
    result.push(100);
  }

  // Ensure monotonically increasing
  for (let i = 1; i < result.length; i++) {
    if (result[i]! <= result[i - 1]!) {
      throw new Error(
        `Rollout percentages must be monotonically increasing, got: ${result.join(',')}`,
      );
    }
  }

  return result;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Safely truncate a string to a maximum length, appending "..." if truncated.
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 1) + '...';
}

/**
 * Redact a sensitive value for log display.
 */
export function redact(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****';
}
