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
    SMOKE_COMMAND_FAILED = "SMOKE_COMMAND_FAILED",
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
/**
 * Individual smoke check definition.
 * Supports per-check configuration for advanced teams.
 */
export interface SmokeCheckDefinition {
    /** Human-readable name for this check */
    name: string;
    /** URL to check */
    url: string;
    /** HTTP method (defaults to GET) */
    method: string;
    /** Additional headers to send */
    headers: Record<string, string>;
    /** Expected HTTP status code */
    expectedStatus: number;
    /** String that response body must contain */
    expectedBodyIncludes?: string;
    /** Per-check timeout in milliseconds */
    timeoutMs: number;
}
export interface SmokeTestConfig {
    /** Individual checks to run */
    checks: SmokeCheckDefinition[];
    /** Number of retry attempts per check */
    retries: number;
    /** Interval between retry attempts in ms */
    retryIntervalMs: number;
    /** Total deadline for all smoke tests in ms */
    deadlineMs: number;
    /** Whether smoke tests are required to proceed */
    required: boolean;
    /** Optional custom command to run instead of / in addition to fetch checks */
    customCommand?: string;
}
/** Promotion strategy */
export type PromotionStrategy = 'immediate' | 'gradual' | 'staging-only';
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
    /** Promotion strategy */
    promotionStrategy: PromotionStrategy;
    /** Seconds to wait between gradual rollout steps */
    gradualStepWaitSeconds: number;
    /** Whether to run smoke tests after each gradual step */
    postStepSmokeTests: boolean;
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
/**
 * Full deployment lifecycle states.
 * Models the run as a progression rather than scattered booleans.
 */
export type DeploymentLifecycle = 'context_resolved' | 'auth_ready' | 'candidate_deploy_started' | 'candidate_deployed' | 'candidate_verified' | 'candidate_verified_only' | 'smoke_tests_running' | 'promotion_in_progress' | 'promoted' | 'post_promotion_verified' | 'rollback_in_progress' | 'rolled_back' | 'failed';
export interface DeployResult {
    /** Whether the deployment succeeded */
    success: boolean;
    /** Worker name used for deployment */
    workerName?: string;
    /** Release tag used as deployment correlation key */
    releaseTag?: string;
    /** Cloudflare Worker version ID */
    versionId?: string;
    /** Cloudflare deployment ID */
    deploymentId?: string;
    /** Staging URL (workers.dev URL) */
    stagingUrl?: string;
    /** Production URL (custom domain, if known) */
    productionUrl?: string;
    /** Primary deployment URL (best available) */
    url?: string;
    /** ISO-8601 timestamp when deployment completed */
    deployedAt?: string;
    /** What triggered this deployment */
    sourceTrigger?: string;
    /** Git commit SHA */
    gitSha?: string;
    /** Git ref (branch or tag) */
    gitRef?: string;
    /** Raw stdout from Wrangler (preserved for partial parsing) */
    stdout: string;
    /** Raw stderr from Wrangler */
    stderr: string;
    /** Raw combined output for diagnostics */
    rawOutput?: string;
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
/** Result for a single smoke check */
export interface SmokeCheckResult {
    /** Check name */
    name: string;
    /** Whether this check passed */
    passed: boolean;
    /** HTTP status code received */
    statusCode?: number;
    /** Whether the expected body substring was found */
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
/** Result for the full smoke test suite */
export interface SmokeTestResult {
    /** Overall pass/fail/skipped */
    status: 'passed' | 'failed' | 'skipped';
    /** Whether the smoke test passed */
    passed: boolean;
    /** Per-check results */
    checks: SmokeCheckResult[];
    /** Custom command output (if used) */
    rawCommandOutput?: string;
    /** ISO-8601 start timestamp */
    startedAt: string;
    /** ISO-8601 finish timestamp */
    finishedAt: string;
    /** Total duration in milliseconds */
    durationMs: number;
    /** Overall failure reason */
    failureReason?: string;
    /** Verification phase: candidate or post-promotion */
    phase: 'candidate' | 'post-promotion';
}
export type PromotionState = 'pending' | 'deploying' | 'smoke-testing' | 'promoting' | 'complete' | 'staging-only' | 'rolled-back' | 'failed';
/**
 * Lightweight run tracker that maps to DeploymentLifecycle.
 * Logs a structured lifecycle instead of scattered booleans.
 */
export interface LifecycleTracker {
    /** Current lifecycle state */
    current: DeploymentLifecycle;
    /** Ordered history of state transitions with timestamps */
    history: Array<{
        state: DeploymentLifecycle;
        timestamp: string;
    }>;
}
/**
 * A single step in a promotion plan.
 */
export interface PromotionStep {
    /** Target traffic percentage */
    percent: number;
    /** Seconds to pause after this step before verification */
    pauseAfterSeconds: number;
    /** Whether to run smoke tests after this step */
    requiresPostStepSmoke: boolean;
    /** Human-readable label */
    label: string;
}
export interface PromotionPlan {
    /** Promotion strategy in use */
    strategy: PromotionStrategy;
    /** Ordered promotion steps */
    steps: PromotionStep[];
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
    /** Version ID of the previous stable version (captured before deployment) */
    previousStableVersionId?: string;
    /** Deployment lifecycle tracker */
    lifecycle?: LifecycleTracker;
    /** Candidate smoke test result */
    candidateSmokeResult?: SmokeTestResult;
    /** Post-promotion smoke test result */
    postPromotionSmokeResult?: SmokeTestResult;
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
    /** Staging URL */
    stagingUrl?: string;
    /** Production URL */
    productionUrl?: string;
    /** Smoke test passed? */
    smokeTestPassed?: boolean;
    /** Promotion result */
    promotionResult: string;
    /** Promotion strategy used */
    promotionStrategy?: string;
    /** Whether rollback was triggered */
    rollbackTriggered: boolean;
    /** Rollback version ID */
    rollbackVersionId?: string;
    /** Release tag */
    releaseTag?: string;
    /** Git SHA */
    gitSha?: string;
    /** Source trigger (event name) */
    sourceTrigger?: string;
    /** Timestamp */
    timestamp: string;
    /** Environment */
    environment: string;
    /** Rollout steps summary */
    rolloutSteps?: string;
    /** Previous stable version (for rollback reference) */
    previousStableVersionId?: string;
}
