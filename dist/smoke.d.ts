import { type SmokeTestConfig, type SmokeTestResult } from './types';
/**
 * Run the full smoke test suite against the deployed Worker.
 *
 * Supports:
 *  - Multiple endpoint checks via native fetch (Node 20)
 *  - Custom command execution
 *  - Configurable retries, timeouts, and total deadline
 *  - Two-phase verification (candidate vs post-promotion)
 */
export declare function runSmokeTest(config: SmokeTestConfig, phase?: 'candidate' | 'post-promotion'): Promise<SmokeTestResult>;
