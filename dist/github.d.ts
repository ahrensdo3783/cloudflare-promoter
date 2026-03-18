import { type ReleaseContext, type ReleaseNotesSection } from './types';
/**
 * Resolve release context from the GitHub event payload.
 * Primarily supports `release.published`, with graceful fallback info
 * for other event types (workflow_dispatch, push, etc.).
 */
export declare function resolveReleaseContext(): ReleaseContext;
/**
 * Update the body of a GitHub Release with deployment information.
 * Uses idempotent section markers so re-runs replace instead of duplicate.
 */
export declare function updateReleaseBody(releaseContext: ReleaseContext, section: ReleaseNotesSection, githubToken: string): Promise<void>;
/**
 * Create a GitHub deployment status for the current deployment.
 */
export declare function createDeploymentStatus(releaseContext: ReleaseContext, state: 'success' | 'failure' | 'in_progress', environmentName: string, deploymentUrl: string | undefined, githubToken: string): Promise<void>;
