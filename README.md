# Workers Release Promoter

A  GitHub Action that turns a **GitHub Release** into a controlled **Cloudflare Workers** production promotion flow -- with promotion strategies, two-phase smoke-test gating, automatic rollback, and release-page deployment annotations.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff)](#)
[![Node.js 20](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=fff)](#)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=fff)](#)

## Integration Workflows

For production-ready integration templates, use these workflow files directly:

- `.github/workflows/integration-release-promotion.yml` -- release-published deployment and promotion flow
- `.github/workflows/integration-pr-validation.yml` -- pull-request dry-run validation flow
- `.github/workflows/integration-merge-promotion.yml` -- merge-group and main-branch promotion flow
- `.github/workflows/integration-feature-matrix.yml` -- manual matrix coverage for strategy and release-note modes

For out-of-the-box testing, this repository also includes a deployable Worker fixture at `.github/integration/worker`.

---

## Features

- **Release-driven deployment** -- triggers on `release.published` (supports `workflow_dispatch`, `push`, `merge_group`, `pull_request`)
- **Promotion strategies** -- three modes: `immediate`, `gradual`, and `staging-only`
- **Gradual rollout** -- split traffic with configurable percentage steps (e.g., `10,50,100`)
- **Two-phase smoke testing** -- candidate verification before promotion, post-promotion verification after
- **Custom smoke commands** -- run any shell command as an additional verification gate
- **Automatic rollback** -- reverts to the previous stable version on failure, with post-rollback health check
- **Granular failure status** -- distinguishes `failed-no-rollback`, `failed-rollback-succeeded`, `failed-rollback-failed`, `failed-rollback-disabled`
- **Release annotations** -- writes a structured deployment section into the GitHub Release body with configurable `append` or `replace-section` behavior
- **Dry-run mode** -- validate everything without deploying
- **Job summaries** -- rich GitHub Actions job summary with rollout tables, lifecycle history, and failure analysis
- **Secure** -- secrets masking, least-privilege tokens, no hardcoded credentials

---

## Quick Start

### 1. Create Cloudflare Secrets

In your repository's **Settings > Secrets and variables > Actions**, add:

| Secret | Description |
| ------ | ----------- |
| `CLOUDFLARE_API_TOKEN` | Scoped API token with Workers deployment permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

### 2. Add to Your Workflow

```yaml
name: Deploy Worker on Release

on:
  release:
    types: [published]

permissions:
  contents: write
  deployments: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - uses: BotCoder254/cloudflare-promoter@v1
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          worker-name: my-worker
          environment: production
          promotion-strategy: gradual
          gradual-steps: '10,50,100'
          release-note-mode: replace-section
          deployment-section-heading: Workers Production Promotion
          smoke-test-url: https://my-worker.example.workers.dev/health
          smoke-test-expected-status: '200'
```

---

## Inputs

### Cloudflare Auth

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `cloudflare-api-token` | Yes* | -- | Cloudflare API token (or set `CLOUDFLARE_API_TOKEN` env var) |
| `cloudflare-account-id` | Yes* | -- | Cloudflare account ID (or set `CLOUDFLARE_ACCOUNT_ID` env var) |

\* Required via input or environment variable.

### Worker Configuration

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `worker-name` | No | -- | Worker name (resolved from wrangler config if omitted) |
| `working-directory` | No | `.` | Path to Worker project directory |
| `environment` | No | `production` | Wrangler environment name |

### Promotion Strategy

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `promotion-strategy` | No | `immediate` | `immediate`, `gradual`, or `staging-only` |
| `gradual-steps` | No | `10,50,100` | Comma-separated rollout percentages (used with `gradual`) |
| `gradual-step-wait-seconds` | No | `5` | Seconds to wait between gradual steps before verification |
| `post-step-smoke-tests` | No | `true` | Run smoke tests after each gradual step |
| `rollout-percentage` | No | `100` | Deprecated alias for `gradual-steps` |

### Smoke Testing

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `smoke-test-url` | No | -- | URL for post-deploy smoke test |
| `smoke-test-paths` | No | -- | Additional paths to check (e.g., `/health,/api/status`) |
| `smoke-test-expected-status` | No | `200` | Expected HTTP status code |
| `smoke-test-expected-body-contains` | No | -- | String the response body must contain |
| `smoke-test-timeout` | No | `10000` | Per-request timeout (ms) |
| `smoke-test-retries` | No | `3` | Retry attempts per check |
| `smoke-test-retry-interval` | No | `2000` | Interval between retries (ms) |
| `smoke-test-deadline` | No | `120000` | Total deadline for all smoke tests (ms) |
| `smoke-test-command` | No | -- | Custom shell command for additional verification |
| `smoke-test-required` | No | `true` | If `false`, failures produce warnings but do not block |

### General

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `auto-rollback` | No | `true` | Enable automatic rollback on failure |
| `dry-run` | No | `false` | Validate without deploying |
| `github-token` | No | `${{ github.token }}` | GitHub token for release annotations |
| `release-note-mode` | No | `replace-section` | `append` or `replace-section` release-note updates |
| `deployment-section-heading` | No | `Workers Production Promotion` | Heading text for release-note deployment section |

---

## Outputs

### Release Context

| Output | Description |
| ------ | ----------- |
| `release-tag` | Git tag of the release |
| `release-id` | GitHub Release ID |
| `release-url` | GitHub Release page URL |
| `workflow-run-url` | GitHub Actions workflow run URL |
| `environment` | Target deployment environment |
| `promotion-strategy` | Strategy requested by the workflow input |

### Deployment Metadata

| Output | Description |
| ------ | ----------- |
| `worker-name` | Cloudflare Worker name used for deployment |
| `deployment-id` | Cloudflare deployment ID |
| `worker-version-id` | Cloudflare Worker version ID |
| `candidate-version-id` | Candidate Worker version ID (alias of `worker-version-id`) |
| `version-id` | Backward-compat alias for `worker-version-id` |
| `staging-url` | Staging URL (workers.dev) |
| `production-url` | Production URL (custom domain) |
| `deployment-url` | Best available URL |
| `previous-stable-version-id` | Version recorded as stable before promotion started |

### Smoke Test

| Output | Description |
| ------ | ----------- |
| `smoke-test-status` | `passed`, `failed`, or `skipped` |
| `smoke-test-passed` | `true`/`false` (empty if skipped) |

### Promotion

| Output | Description |
| ------ | ----------- |
| `promotion-status` | Granular status (see table below) |
| `promotion-result` | Alias for `promotion-status` |

### Rollback

| Output | Description |
| ------ | ----------- |
| `rollback-triggered` | Whether rollback was attempted (`true`/`false`) |
| `rollback-version-id` | Version ID rolled back to |
| `rollback-succeeded` | Whether rollback succeeded (`true`/`false`) |
| `post-rollback-healthy` | Whether post-rollback health check passed |

### Promotion Status Values

| Status | Meaning |
| ------ | ------- |
| `success` | Deployment and promotion completed successfully |
| `staging-only` | Candidate deployed and verified (no production promotion) |
| `dry-run` | Validation only, no deployment |
| `failed-no-rollback` | Failed, no previous version to rollback to |
| `failed-rollback-succeeded` | Failed, rolled back to previous version successfully |
| `failed-rollback-failed` | Failed, rollback also failed (manual intervention needed) |
| `failed-rollback-disabled` | Failed, auto-rollback was disabled |

---

## GitHub Release Annotation

Every run can annotate the GitHub Release body with a structured deployment section so the release page becomes the source of truth for delivery status.

The deployment section records at minimum:

- Worker name
- Release tag and release ID
- Candidate version ID and deployment ID
- Staging and production URLs
- Promotion strategy and promotion result
- Smoke-test result
- Rollback information
- Timestamp
- GitHub workflow run link (when available)

Release-note update modes:

- `replace-section` (default): keeps one idempotent section under your configured heading
- `append`: adds a new section for every run

Example configuration:

```yaml
permissions:
  contents: write

with:
  release-note-mode: replace-section
  deployment-section-heading: Workers Production Promotion
```

---

## Promotion Strategies

### Immediate (default)

Deploys the candidate and promotes to 100% traffic in one step. Post-promotion smoke tests run after deployment.

```yaml
promotion-strategy: immediate
```

### Gradual

Uploads the candidate version, then promotes through configurable traffic-split steps. Smoke tests run between each step.

```yaml
promotion-strategy: gradual
gradual-steps: '10,50,100'
gradual-step-wait-seconds: '30'
post-step-smoke-tests: 'true'
```

At each step, the action:
1. Promotes the new version to the specified percentage
2. Waits the configured interval for propagation
3. Runs smoke tests against the production URL
4. On failure: rolls back to the previous stable version
5. On success: proceeds to the next step

### Staging-Only

Deploys and verifies the candidate without promoting to production traffic. Useful for teams that want release publication to create a validated candidate, leaving final go-live to a separate workflow or manual step.

```yaml
promotion-strategy: staging-only
```

---

## Smoke Testing

Smoke tests are production-safety gates, not replacements for full QA suites. They catch obvious regressions before or during promotion.

### Two-Phase Verification

1. **Candidate verification** -- runs after deployment, before promotion. If this fails, no production traffic is affected.
2. **Post-promotion verification** -- runs after traffic moves. If this fails and rollback is enabled, the previous version is restored.

### Multiple Endpoints

Check multiple paths with a single base URL:

```yaml
smoke-test-url: https://my-worker.example.workers.dev
smoke-test-paths: '/health,/api/status,/'
```

### Custom Commands

Run any shell command as an additional verification gate:

```yaml
smoke-test-command: 'npm run test:smoke'
```

If both `smoke-test-url` and `smoke-test-command` are provided, both run. Fetch-based checks execute first, then the custom command.

### Retry Behavior

Each check supports configurable retries to handle transient propagation delays:

```yaml
smoke-test-retries: '3'
smoke-test-retry-interval: '2000'
smoke-test-deadline: '120000'
```

---

## Automatic Rollback

When `auto-rollback: true` (the default), the action records the current stable version before any changes, then automatically restores it on failure.

### Rollback Triggers

- Candidate smoke tests fail before full promotion
- A gradual step fails post-step verification
- Post-promotion health checks fail after 100% traffic
- Promotion command itself fails

### Post-Rollback Health Check

After rollback, the action runs smoke tests against the restored version to confirm service recovery. The `post-rollback-healthy` output reports the result.

### When Rollback Does Not Apply

- **Pre-deploy failures** -- if deployment never started, there is nothing to roll back
- **Staging-only failures** -- no production traffic was affected
- **No previous version** -- first deployment has no rollback target
- **Rollback disabled** -- `auto-rollback: false` skips recovery

### Failure Transparency

The action does not swallow errors or pretend success. When a failure occurs, the release notes and job summary include:

- Which phase failed (candidate-deploy, candidate-smoke, promotion-step, post-promotion-smoke)
- What traffic percentage was affected
- Whether rollback was attempted and whether it succeeded
- Post-rollback health status

---

## Versioning and Adoption

Public consumers should pin this action by major tag for compatibility updates:

```yaml
uses: BotCoder254/cloudflare-promoter@v1
```

Release strategy in this repository:

- Immutable semantic tags (for example `v1.0.0`)
- Movable major channel tags (for example `v1`)

For maximum supply-chain stability, pin to a full commit SHA in critical workflows. For easier updates, pin to the major tag.

---

## Architecture

```
src/
  index.ts          # Orchestration entrypoint
  inputs.ts         # Parse, normalize, validate inputs
  github.ts         # Event resolution and GitHub API ops
  cloudflare.ts     # Wrangler CLI wrapper and typed adapters
  smoke.ts          # Native fetch-based smoke test engine
  promotion.ts      # Promotion plans, strategies, state machine
  releaseNotes.ts   # Markdown generation and section management
  types.ts          # Shared domain models and error codes
  utils.ts          # Helpers (retry, sleep, masking, parsing)
```

### Promotion Flow

```
  Parse       Resolve      Validate     Deploy
  Inputs  --> Release  --> Wrangler --> Candidate
                                          |
                  .---------------------------'
                  v
          Candidate        Promote      Post-Promotion
          Smoke Test  -->  Step N%  --> Smoke Test
              |                |            |
              | failed         | repeat     | failed
              v                |            v
          Rollback  <----------'        Rollback
          to Stable                     to Stable
              |                             |
              v                             v
          Post-Rollback                Post-Rollback
          Health Check                 Health Check
```

---

## Security

- **Secrets masking** -- API tokens are masked in all log output via `@actions/core.setSecret()`
- **Least privilege** -- Create a Cloudflare API token scoped only to Workers for the target account
- **No hardcoded credentials** -- Auth resolved from inputs or env vars at runtime
- **Command hygiene** -- CLI invocations never print sensitive environment values

---

## CI and Release Automation

This repository includes first-party workflows under `.github/workflows/` to keep the action reproducible and consumer-safe:

- `ci.yml` runs lint, tests, TypeScript build, ncc bundle, and verifies committed `dist/` artifacts are up to date
- `release.yml` runs quality checks on version tags (`v*`) and publishes a GitHub Release

This ensures published tags are validated and the runtime bundle consumed by external repositories is exactly what was reviewed in source control.

---

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Bundle with ncc (creates dist/index.js)
npm run bundle

# Full check (lint + test + build + bundle)
npm run check
```

### Tech Stack

| Component | Technology |
| --------- | ---------- |
| Language | TypeScript |
| Runtime | Node.js 20 |
| Action SDK | @actions/core, @actions/github |
| CLI execution | execa |
| Bundler | @vercel/ncc |
| Worker management | Wrangler CLI |

---

## License

MIT
