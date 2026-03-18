/**
 * Structured error codes for every known failure mode.
 * Enables downstream consumers to switch on failure type.
 */
export declare enum ErrorCode {
    MISSING_API_TOKEN = "MISSING_API_TOKEN",
    MISSING_ACCOUNT_ID = "MISSING_ACCOUNT_ID",
    AUTH_REJECTED = "AUTH_REJECTED",
    WRANGLER_NOT_FOUND = "WRANGLER_NOT_FOUND",
    WRANGLER_COMMAND_FAILED = "WRANGLER_COMMAND_FAILED",
    DEPLOY_FAILED = "DEPLOY_FAILED",
    DEPLOY_OUTPUT_PARSE_FAILED = "DEPLOY_OUTPUT_PARSE_FAILED",
    PROMOTE_FAILED = "PROMOTE_FAILED",
    ROLLBACK_FAILED = "ROLLBACK_FAILED",
    VERSION_LOOKUP_FAILED = "VERSION_LOOKUP_FAILED",
    INVALID_WORKING_DIRECTORY = "INVALID_WORKING_DIRECTORY",
    INVALID_WORKER_CONFIG = "INVALID_WORKER_CONFIG",
    SMOKE_TEST_FAILED = "SMOKE_TEST_FAILED",
    SMOKE_TEST_TIMEOUT = "SMOKE_TEST_TIMEOUT",
    INVALID_INPUT = "INVALID_INPUT",
    MISSING_RELEASE_CONTEXT = "MISSING_RELEASE_CONTEXT",
    GITHUB_API_FAILED = "GITHUB_API_FAILED",
    UNKNOWN = "UNKNOWN"
}
/**
 * Typed action error with domain error code.
 */
export declare class ActionError extends Error {
    readonly code: ErrorCode;
    readonly cause?: unknown | undefined;
    constructor(code: ErrorCode, message: string, cause?: unknown | undefined);
}
export interface CloudflareAuth {
    apiToken: string;
    accountId: string;
}
export interface SmokeTestConfig {
    url: string;
    expectedStatus: number;
    expectedBodyContains?: string;
    timeoutMs: number;
    retries: number;
}
export interface ActionInputs {
    /** Cloudflare authentication bundle */
    auth: CloudflareAuth;
    /** Worker name (may be undefined if resolved from config) */
    workerName?: string;
    /** Working directory for the worker project */
    workingDirectory: string;
    /** Wrangler environment (e.g., "production") */
    environment: string;
    /** Smoke test configuration (undefined if no URL provided) */
    smokeTest?: SmokeTestConfig;
    /** Rollout percentages for gradual deployment */
    rolloutSteps: number[];
    /** Validate only, don't deploy */
    dryRun: boolean;
    /** GitHub token for API operations */
    githubToken: string;
}
export interface ReleaseContext {
    /** Release ID on GitHub */
    id: number;
    /** Tag name (e.g., "v1.2.3") */
    tagName: string;
    /** Release title */
    name: string;
    /** Release body (markdown) */
    body: string;
    /** Whether this is a pre-release */
    prerelease: boolean;
    /** Whether this is a draft */
    draft: boolean;
    /** HTML URL of the release page */
    htmlUrl: string;
    /** Repository owner */
    owner: string;
    /** Repository name */
    repo: string;
    /** Commit SHA the release points to */
    targetCommitish: string;
}
export interface DeployResult {
    /** Whether the deployment succeeded */
    success: boolean;
    /** Cloudflare version ID */
    versionId?: string;
    /** Cloudflare deployment ID */
    deploymentId?: string;
    /** Deployment URL */
    url?: string;
    /** Raw stdout from Wrangler */
    stdout: string;
    /** Raw stderr from Wrangler */
    stderr: string;
}
export interface PromotionStepResult {
    /** The rollout percentage for this step */
    percentage: number;
    /** Whether this step succeeded */
    success: boolean;
    /** Optional message or error */
    message?: string;
    /** Smoke test result at this step (if applicable) */
    smokeTest?: SmokeTestResult;
}
export interface RollbackResult {
    /** Whether the rollback succeeded */
    success: boolean;
    /** Version ID rolled back to */
    rolledBackToVersionId?: string;
    /** Message or error */
    message: string;
    /** Raw stdout */
    stdout: string;
    /** Raw stderr */
    stderr: string;
}
export interface SmokeTestResult {
    /** Whether the smoke test passed */
    passed: boolean;
    /** HTTP status code received */
    statusCode?: number;
    /** Whether the expected body was found */
    bodyMatch?: boolean;
    /** Latency in milliseconds */
    latencyMs: number;
    /** Body snippet (first 500 chars) */
    bodySnippet?: string;
    /** Error message if failed */
    error?: string;
    /** Number of attempts made */
    attempts: number;
}
export type PromotionState = 'pending' | 'deploying' | 'smoke-testing' | 'promoting' | 'complete' | 'rolled-back' | 'failed';
export interface PromotionPlan {
    /** Ordered rollout percentage steps */
    steps: number[];
    /** Whether smoke tests are enabled between steps */
    smokeTestEnabled: boolean;
    /** Worker name */
    workerName?: string;
    /** Environment */
    environment: string;
}
export interface PromotionResult {
    /** Final state of the promotion */
    state: PromotionState;
    /** Deploy result from initial candidate deployment */
    deploy?: DeployResult;
    /** Results from each promotion step */
    stepResults: PromotionStepResult[];
    /** Rollback result, if applicable */
    rollback?: RollbackResult;
    /** Overall error message, if failed */
    error?: string;
    /** Version ID of the previous stable version */
    previousStableVersionId?: string;
    /** Timestamp when promotion started */
    startedAt: string;
    /** Timestamp when promotion completed */
    completedAt?: string;
}
export interface ReleaseNotesSection {
    /** Deployment ID */
    deploymentId?: string;
    /** Version ID */
    versionId?: string;
    /** Deployment URL */
    url?: string;
    /** Smoke test passed? */
    smokeTestPassed?: boolean;
    /** Promotion result */
    promotionResult: string;
    /** Whether rollback was triggered */
    rollbackTriggered: boolean;
    /** Timestamp */
    timestamp: string;
    /** Environment */
    environment: string;
    /** Rollout steps summary */
    rolloutSteps?: string;
}
