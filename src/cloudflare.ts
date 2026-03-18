// ─────────────────────────────────────────────────────────
// src/cloudflare.ts — Wrangler CLI wrapper & typed adapters
// ─────────────────────────────────────────────────────────

import * as core from '@actions/core';
import * as github from '@actions/github';
import { type ExecaReturnValue } from 'execa';
import {
  type ActionInputs,
  type DeployResult,
  type ReleaseContext,
  type RollbackResult,
  type PromotionStepResult,
  ActionError,
  ErrorCode,
} from './types';
import { timestamp } from './utils';

/**
 * Execute a Wrangler CLI command with proper environment setup.
 * All Cloudflare commands flow through this single bottleneck.
 */
async function execWrangler(
  args: string[],
  inputs: ActionInputs,
  options?: { cwd?: string },
): Promise<ExecaReturnValue> {
  // Dynamic import for execa (CommonJS compat with v5)
  const execaMod = await import('execa');
  const execa = execaMod.default ?? execaMod;

  const cwd = options?.cwd || inputs.workingDirectory;
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLOUDFLARE_API_TOKEN: inputs.auth.apiToken,
    CLOUDFLARE_ACCOUNT_ID: inputs.auth.accountId,
  };

  const safeArgs = args.map((a) =>
    a.includes(inputs.auth.apiToken) ? '***' : a,
  );
  core.info(`[wrangler] Running: wrangler ${safeArgs.join(' ')}`);

  try {
    const result = await execa('npx', ['wrangler', ...args], {
      cwd,
      env,
      reject: false,
      timeout: 300_000, // 5 minute timeout
    });

    if (result.exitCode !== 0) {
      core.warning(`[wrangler] Exited with code ${result.exitCode}`);
      core.debug(`[wrangler] stdout: ${result.stdout}`);
      core.debug(`[wrangler] stderr: ${result.stderr}`);
    }

    return result;
  } catch (err) {
    throw new ActionError(
      ErrorCode.WRANGLER_COMMAND_FAILED,
      `Wrangler command failed: wrangler ${safeArgs.join(' ')}`,
      err,
    );
  }
}

/**
 * Ensure Wrangler is available in the path.
 */
export async function ensureWrangler(inputs: ActionInputs): Promise<void> {
  core.info('[wrangler] Checking Wrangler availability');
  try {
    const result = await execWrangler(['--version'], inputs);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || 'Unknown error');
    }
    core.info(`[wrangler] Found: ${result.stdout.trim()}`);
  } catch (err) {
    if (err instanceof ActionError) throw err;
    throw new ActionError(
      ErrorCode.WRANGLER_NOT_FOUND,
      'Wrangler CLI is not available. Install it via "npm install -g wrangler" or add it to your project dependencies.',
      err,
    );
  }
}

/**
 * Deploy the Worker candidate using `wrangler deploy`.
 * This uploads code and immediately routes traffic to the new version.
 *
 * Captures full deployment metadata including release correlation,
 * git context, and parsed staging/production URLs.
 */
export async function deployCandidate(
  inputs: ActionInputs,
  releaseContext?: ReleaseContext,
): Promise<DeployResult> {
  core.info('[deploy] Deploying candidate Worker version');

  const args = ['deploy'];

  if (inputs.workerName) {
    args.push('--name', inputs.workerName);
  }

  if (inputs.environment && inputs.environment !== 'production') {
    args.push('--env', inputs.environment);
  }

  const result = await execWrangler(args, inputs);
  const rawOutput = `${result.stdout}\n${result.stderr}`.trim();

  if (result.exitCode !== 0) {
    return {
      success: false,
      workerName: inputs.workerName,
      releaseTag: releaseContext?.tagName,
      sourceTrigger: github.context.eventName,
      gitSha: github.context.sha,
      gitRef: github.context.ref,
      stdout: result.stdout,
      stderr: result.stderr,
      rawOutput,
    };
  }

  // Parse deployment info from stdout
  const parsed = parseDeployOutput(result.stdout);

  return {
    success: true,
    workerName: inputs.workerName || parsed.workerName,
    releaseTag: releaseContext?.tagName,
    versionId: parsed.versionId,
    deploymentId: parsed.deploymentId,
    stagingUrl: parsed.stagingUrl,
    productionUrl: parsed.productionUrl,
    url: parsed.productionUrl || parsed.stagingUrl,
    deployedAt: timestamp(),
    sourceTrigger: github.context.eventName,
    gitSha: github.context.sha,
    gitRef: github.context.ref,
    stdout: result.stdout,
    stderr: result.stderr,
    rawOutput,
  };
}

/**
 * Upload a new version without deploying it using `wrangler versions upload`.
 * Returns the version ID for subsequent gradual promotion.
 */
export async function uploadVersion(inputs: ActionInputs): Promise<string> {
  core.info('[deploy] Uploading new Worker version (without deploying)');

  const args = ['versions', 'upload'];

  if (inputs.workerName) {
    args.push('--name', inputs.workerName);
  }

  const result = await execWrangler(args, inputs);

  if (result.exitCode !== 0) {
    throw new ActionError(
      ErrorCode.DEPLOY_FAILED,
      `Version upload failed: ${result.stderr || result.stdout}`,
    );
  }

  // Extract version ID from output
  const versionMatch = result.stdout.match(
    /Version ID:\s*([a-f0-9-]+)/i,
  ) || result.stdout.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);

  if (!versionMatch?.[1]) {
    throw new ActionError(
      ErrorCode.DEPLOY_OUTPUT_PARSE_FAILED,
      'Could not parse version ID from wrangler versions upload output.',
    );
  }

  core.info(`[deploy] Version uploaded: ${versionMatch[1]}`);
  return versionMatch[1];
}

/**
 * Look up the current stable (active) version of a Worker.
 * Returns the version ID or undefined if no active version exists.
 */
export async function lookupCurrentStableVersion(
  inputs: ActionInputs,
): Promise<string | undefined> {
  core.info('[deploy] Looking up current stable Worker version');

  const args = ['versions', 'list'];

  if (inputs.workerName) {
    args.push('--name', inputs.workerName);
  }

  const result = await execWrangler(args, inputs);

  if (result.exitCode !== 0) {
    core.warning('[deploy] Could not look up current stable version -- proceeding without rollback target');
    return undefined;
  }

  // Parse the first (most recent active) version from the output
  const versionMatch = result.stdout.match(
    /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/,
  );

  if (versionMatch?.[1]) {
    core.info(`[deploy] Current stable version: ${versionMatch[1]}`);
    return versionMatch[1];
  }

  core.info('[deploy] No existing stable version found (first deployment?)');
  return undefined;
}

/**
 * Promote a specific version to handle a given percentage of traffic.
 * Uses `wrangler versions deploy` for gradual rollout.
 */
export async function promoteVersion(
  versionId: string,
  percentage: number,
  inputs: ActionInputs,
  previousVersionId?: string,
): Promise<PromotionStepResult> {
  core.info(`[promote] Promoting version ${versionId} to ${percentage}% traffic`);

  if (percentage === 100) {
    // Full promotion -- use wrangler versions deploy with 100%
    const args = [
      'versions',
      'deploy',
      `${versionId}@${percentage}%`,
    ];

    if (inputs.workerName) {
      args.push('--name', inputs.workerName);
    }

    // Add --yes to skip confirmation prompts
    args.push('--yes');

    const result = await execWrangler(args, inputs);

    return {
      percentage,
      success: result.exitCode === 0,
      message: result.exitCode === 0
        ? `Version ${versionId} promoted to 100% traffic`
        : `Promotion failed: ${result.stderr || result.stdout}`,
    };
  }

  // Gradual promotion -- split traffic between old and new
  if (!previousVersionId) {
    core.warning(
      '[promote] No previous version for gradual split -- promoting new version directly',
    );
    const args = [
      'versions',
      'deploy',
      `${versionId}@${percentage}%`,
      '--yes',
    ];

    if (inputs.workerName) {
      args.push('--name', inputs.workerName);
    }

    const result = await execWrangler(args, inputs);

    return {
      percentage,
      success: result.exitCode === 0,
      message: result.exitCode === 0
        ? `Version ${versionId} set to ${percentage}% traffic`
        : `Promotion failed: ${result.stderr || result.stdout}`,
    };
  }

  const remaining = 100 - percentage;
  const args = [
    'versions',
    'deploy',
    `${versionId}@${percentage}%`,
    `${previousVersionId}@${remaining}%`,
    '--yes',
  ];

  if (inputs.workerName) {
    args.push('--name', inputs.workerName);
  }

  const result = await execWrangler(args, inputs);

  return {
    percentage,
    success: result.exitCode === 0,
    message: result.exitCode === 0
      ? `Traffic split: ${percentage}% new (${versionId}), ${remaining}% stable (${previousVersionId})`
      : `Promotion failed: ${result.stderr || result.stdout}`,
  };
}

/**
 * Rollback to a previously known stable version.
 */
export async function rollbackToVersion(
  versionId: string,
  inputs: ActionInputs,
): Promise<RollbackResult> {
  core.info(`[rollback] Rolling back to version ${versionId}`);

  const args = ['versions', 'deploy', `${versionId}@100%`, '--yes'];

  if (inputs.workerName) {
    args.push('--name', inputs.workerName);
  }

  const result = await execWrangler(args, inputs);

  if (result.exitCode === 0) {
    core.info(`[rollback] Successfully rolled back to version ${versionId}`);
    return {
      success: true,
      rolledBackToVersionId: versionId,
      message: `Rolled back to version ${versionId}`,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  core.error(`[rollback] Rollback failed: ${result.stderr || result.stdout}`);
  return {
    success: false,
    rolledBackToVersionId: versionId,
    message: `Rollback to ${versionId} failed: ${result.stderr || result.stdout}`,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// ─── Internal Helpers ────────────────────────────────────

interface ParsedDeployOutput {
  versionId?: string;
  deploymentId?: string;
  workerName?: string;
  stagingUrl?: string;
  productionUrl?: string;
}

function parseDeployOutput(stdout: string): ParsedDeployOutput {
  const result: ParsedDeployOutput = {};

  // Try to extract version/deployment ID (UUID format)
  const uuidMatch = stdout.match(
    /(?:Version|Deployment)\s*(?:ID)?:?\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i,
  );
  if (uuidMatch?.[1]) {
    result.versionId = uuidMatch[1];
    result.deploymentId = uuidMatch[1];
  }

  // Try to extract worker name from output
  const nameMatch = stdout.match(/Uploaded\s+([a-zA-Z0-9_-]+)/i)
    || stdout.match(/Published\s+([a-zA-Z0-9_-]+)/i);
  if (nameMatch?.[1]) {
    result.workerName = nameMatch[1];
  }

  // Extract staging URL (workers.dev)
  const workersDevMatch = stdout.match(
    /https:\/\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.workers\.dev/,
  );
  if (workersDevMatch?.[0]) {
    result.stagingUrl = workersDevMatch[0];
  }

  // Extract production URL (custom domains / routes)
  const customUrlMatch = stdout.match(
    /Published\s+.*?\s+to\s+(https?:\/\/(?!.*workers\.dev)\S+)/i,
  );
  if (customUrlMatch?.[1]) {
    result.productionUrl = customUrlMatch[1];
  }

  // Also check route patterns
  const routeMatch = stdout.match(
    /route:\s*(https?:\/\/(?!.*workers\.dev)\S+)/i,
  );
  if (routeMatch?.[1] && !result.productionUrl) {
    result.productionUrl = routeMatch[1];
  }

  return result;
}
