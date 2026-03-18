import { type ActionInputs, type PromotionPlan, type PromotionResult, type ReleaseContext } from './types';
/**
 * Build a promotion plan from action inputs.
 * Normalizes user-friendly strategy names into executable step sequences.
 */
export declare function buildPromotionPlan(inputs: ActionInputs): PromotionPlan;
/**
 * Execute the full promotion flow:
 *
 *  1. Look up current stable version (rollback target)
 *  2. Deploy or upload candidate
 *  3. Run candidate smoke tests (if enabled)
 *  4. For staging-only: stop after verification
 *  5. For immediate/gradual:
 *     a. Execute each promotion step
 *     b. Run post-step smoke tests (if enabled)
 *     c. On failure -> rollback to stable
 *  6. Run post-promotion verification (if enabled)
 *  7. Return the overall result
 */
export declare function executePromotion(inputs: ActionInputs, plan: PromotionPlan, releaseContext?: ReleaseContext): Promise<PromotionResult>;
