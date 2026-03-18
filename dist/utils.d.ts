/**
 * Sleep for a given number of milliseconds.
 */
export declare function sleep(ms: number): Promise<void>;
/**
 * Retry an async function with exponential backoff.
 *
 * @param fn        The async function to retry
 * @param retries   Maximum number of retry attempts
 * @param delayMs   Initial delay between retries (doubles each attempt)
 * @param label     Label for logging
 */
export declare function retry<T>(fn: () => Promise<T>, retries: number, delayMs?: number, label?: string): Promise<T>;
/**
 * Returns an ISO-8601 timestamp string for the current moment.
 */
export declare function timestamp(): string;
/**
 * Mask a secret value in GitHub Actions logs.
 * Wraps @actions/core.setSecret for convenience.
 */
export declare function maskSecret(value: string): void;
/**
 * Parse a comma-separated string of integers into a number array.
 * E.g., "10,50,100" → [10, 50, 100]
 *
 * @throws Error if any value is not a valid positive integer ≤ 100
 */
export declare function parsePercentages(input: string): number[];
/**
 * Format a duration in milliseconds to a human-readable string.
 * E.g., 12345 → "12.3s", 1234 → "1.2s", 500 → "500ms"
 */
export declare function formatDuration(ms: number): string;
/**
 * Safely truncate a string to a maximum length, appending "…" if truncated.
 */
export declare function truncate(str: string, maxLength: number): string;
/**
 * Redact a sensitive value for log display.
 * Shows first 4 chars + "****" for strings longer than 8 chars.
 */
export declare function redact(value: string): string;
