import { type SmokeTestConfig, type SmokeTestResult } from './types';
/**
 * Run a smoke test against the deployed Worker.
 *
 * Uses Node 20 native fetch (no extra HTTP dependencies).
 * Supports: expected status, body-contains check, timeout, retries with backoff.
 */
export declare function runSmokeTest(config: SmokeTestConfig): Promise<SmokeTestResult>;
