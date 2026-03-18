import { type ActionInputs, type DeployResult, type RollbackResult, type PromotionStepResult } from './types';
/**
 * Ensure Wrangler is available in the path.
 */
export declare function ensureWrangler(inputs: ActionInputs): Promise<void>;
/**
 * Deploy the Worker candidate using `wrangler deploy`.
 * This uploads code and immediately routes traffic to the new version.
 */
export declare function deployCandidate(inputs: ActionInputs): Promise<DeployResult>;
/**
 * Upload a new version without deploying it using `wrangler versions upload`.
 * Returns the version ID for subsequent gradual promotion.
 */
export declare function uploadVersion(inputs: ActionInputs): Promise<string>;
/**
 * Look up the current stable (active) version of a Worker.
 * Returns the version ID or undefined if no active version exists.
 */
export declare function lookupCurrentStableVersion(inputs: ActionInputs): Promise<string | undefined>;
/**
 * Promote a specific version to handle a given percentage of traffic.
 * Uses `wrangler versions deploy` for gradual rollout.
 */
export declare function promoteVersion(versionId: string, percentage: number, inputs: ActionInputs, previousVersionId?: string): Promise<PromotionStepResult>;
/**
 * Rollback to a previously known stable version.
 */
export declare function rollbackToVersion(versionId: string, inputs: ActionInputs): Promise<RollbackResult>;
