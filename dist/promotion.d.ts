import { type ActionInputs, type PromotionPlan, type PromotionResult } from './types';
/**
 * Build a promotion plan from action inputs.
 */
export declare function buildPromotionPlan(inputs: ActionInputs): PromotionPlan;
/**
 * Execute the full promotion flow:
 *
 *  1. Look up current stable version (rollback target)
 *  2. Upload new version
 *  3. For each rollout step:
 *     a. Promote to the step's percentage
 *     b. Run smoke tests (if enabled)
 *     c. On failure → rollback to stable
 *  4. Return the overall result
 */
export declare function executePromotion(inputs: ActionInputs, plan: PromotionPlan): Promise<PromotionResult>;
