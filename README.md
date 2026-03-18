# Workers Release Promoter

A marketplace-quality GitHub Action that turns a **GitHub Release** into a controlled **Cloudflare Workers** production promotion flow — with staged rollout, smoke-test gating, automatic rollback, and release-page deployment annotations.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=fff)](#)
[![Node.js 20](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=fff)](#)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=fff)](#)

---

## Features

- **🚀 Release-driven deployment** — triggers on `release.published` (supports `workflow_dispatch`, `push`, `merge_group`)
- **📈 Gradual rollout** — split traffic with configurable percentage steps (e.g., `10,50,100`)
- **🧪 Smoke-test gating** — native `fetch`-based checks between rollout steps
- **⏪ Automatic rollback** — reverts to the previous stable version on failure
- **📝 Release annotations** — appends deployment details to the GitHub Release body
- **🔍 Dry-run mode** — validate everything without deploying
- **📊 Job summaries** — rich GitHub Actions job summary with rollout tables
- **🔒 Secure** — secrets masking, least-privilege tokens, no hardcoded credentials

---

## Quick Start

### 1. Create Cloudflare Secrets

In your repository's **Settings → Secrets and variables → Actions**, add:

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

      - uses: your-org/workers-release-promoter@v1
        with:
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          worker-name: my-worker
          environment: production
          smoke-test-url: https://my-worker.example.workers.dev/health
          smoke-test-expected-status: '200'
          rollout-percentage: '10,50,100'
```

---

## Inputs

| Input | Required | Default | Description |
| ----- | -------- | ------- | ----------- |
| `cloudflare-api-token` | Yes* | — | Cloudflare API token (or set `CLOUDFLARE_API_TOKEN` env var) |
| `cloudflare-account-id` | Yes* | — | Cloudflare account ID (or set `CLOUDFLARE_ACCOUNT_ID` env var) |
| `worker-name` | No | — | Worker name (resolved from wrangler config if omitted) |
| `working-directory` | No | `.` | Path to Worker project directory |
| `environment` | No | `production` | Wrangler environment name |
| `smoke-test-url` | No | — | URL for post-deploy smoke test |
| `smoke-test-expected-status` | No | `200` | Expected HTTP status from smoke test |
| `smoke-test-expected-body-contains` | No | — | String the response body must contain |
| `smoke-test-timeout` | No | `10000` | Smoke test request timeout (ms) |
| `smoke-test-retries` | No | `3` | Smoke test retry attempts |
| `rollout-percentage` | No | `100` | Comma-separated rollout steps (e.g., `10,50,100`) |
| `dry-run` | No | `false` | Validate without deploying |
| `github-token` | No | `${{ github.token }}` | GitHub token for release annotations |

\* Required via input or environment variable.

---

## Outputs

| Output | Description |
| ------ | ----------- |
| `deployment-id` | Cloudflare deployment ID |
| `version-id` | Cloudflare Worker version ID |
| `deployment-url` | Deployed Worker URL |
| `smoke-test-passed` | `true`/`false` (empty if skipped) |
| `rollback-triggered` | `true`/`false` |
| `promotion-result` | `success`, `rolled-back`, or `failed` |

---

## Architecture

```
src/
├── index.ts          # Orchestration entrypoint
├── inputs.ts         # Parse, normalize, validate inputs
├── github.ts         # Event resolution & GitHub API ops
├── cloudflare.ts     # Wrangler CLI wrapper & typed adapters
├── smoke.ts          # Native fetch-based smoke test engine
├── promotion.ts      # Promotion plans, gradual rollout, state machine
├── releaseNotes.ts   # Markdown generation & section management
├── types.ts          # Shared domain models & error codes
└── utils.ts          # Helpers (retry, sleep, masking, parsing)
```

### Promotion Flow

```
┌──────────┐    ┌───────────┐    ┌──────────────┐    ┌───────────┐
│  Parse   │───▶│  Resolve  │───▶│   Validate   │───▶│  Deploy   │
│  Inputs  │    │  Release  │    │   Wrangler   │    │ Candidate │
└──────────┘    └───────────┘    └──────────────┘    └─────┬─────┘
                                                           │
                    ┌──────────────────────────────────────┘
                    ▼
            ┌──────────────┐     ┌───────────┐     ┌──────────────┐
            │  Smoke Test  │────▶│  Promote  │────▶│   Release    │
            │   (if URL)   │     │  Step N%  │     │   Notes      │
            └──────┬───────┘     └─────┬─────┘     └──────────────┘
                   │                   │
                   │ failed            │ repeat for each step
                   ▼                   │
            ┌──────────────┐           │
            │   Rollback   │◀──────────┘
            │  to Stable   │     (on failure)
            └──────────────┘
```

---

## Gradual Rollout

The `rollout-percentage` input controls traffic splitting:

```yaml
# Immediate (default)
rollout-percentage: '100'

# Three-phase rollout with smoke tests between each step
rollout-percentage: '10,50,100'

# Canary → half → full
rollout-percentage: '5,50,100'
```

At each step, the action:
1. Promotes the new version to the specified percentage
2. Runs smoke tests (if configured)
3. On failure: rolls back to the previous stable version
4. On success: proceeds to the next step

---

## Security

- **Secrets masking** — API tokens are masked in all log output via `@actions/core.setSecret()`
- **Least privilege** — Create a Cloudflare API token scoped only to Workers for the target account
- **No hardcoded credentials** — Auth resolved from inputs or env vars at runtime
- **Command hygiene** — CLI invocations never print sensitive environment values

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
