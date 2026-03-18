import { type ReleaseNotesSection, type PromotionResult } from './types';
/**
 * Build a ReleaseNotesSection from a PromotionResult and deployment context.
 */
export declare function buildReleaseNotesSection(result: PromotionResult, environment: string, rolloutSteps?: number[]): ReleaseNotesSection;
/**
 * Build the deployment summary markdown for the GitHub Actions job summary.
 */
export declare function buildJobSummary(result: PromotionResult, environment: string, tagName?: string): string;
