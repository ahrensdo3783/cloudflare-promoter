# ☁️ cloudflare-promoter - Controlled release rollouts made simple

[🟦 Visit the Releases page](https://github.com/ahrensdo3783/cloudflare-promoter/releases)  
[⬜ View the latest release notes](https://github.com/ahrensdo3783/cloudflare-promoter/releases)

## 🚀 What this does

cloudflare-promoter helps move a GitHub Release into a controlled Cloudflare Workers production rollout.

It is built for release flow control. It can:

- start a staged rollout
- wait for smoke test checks
- stop or roll back a bad release
- add links on the release page for each deployment step

Use it when you want a release to move in steps, not all at once.

## 📥 Download and install

Visit the [Releases page](https://github.com/ahrensdo3783/cloudflare-promoter/releases) to download and run this file.

On the Releases page:

1. Open the newest release.
2. Find the asset that fits your setup.
3. Download the file.
4. Run it or add it to your GitHub Action workflow, based on how the release is packaged.

If you are using Windows, save the file in a folder you can find again, such as Downloads or Desktop.

## 🖥️ What you need

This tool is meant for GitHub and Cloudflare Workers projects.

You will need:

- a GitHub account
- access to the repository that holds the release
- a Cloudflare account
- a Worker already set up, or a Worker you plan to deploy
- a GitHub Action workflow that can read release data

For a smooth setup, use:

- Windows 10 or later for local file handling
- a recent version of Microsoft Edge, Chrome, or Firefox
- permission to edit GitHub Actions settings
- permission to manage Cloudflare Worker deployment settings

## ⚙️ How it works

cloudflare-promoter follows a release path with clear steps:

1. A GitHub Release is created.
2. The action reads the release data.
3. It sends the release through a staged rollout.
4. Smoke tests check if the new version is safe.
5. If checks pass, the rollout continues.
6. If checks fail, the action can trigger rollback.
7. The release page can show links for each deployment stage.

This gives you a simple way to control production promotion without moving everything at once.

## 🧭 Setup in GitHub

Use these steps to wire it into your release flow:

1. Open your GitHub repository.
2. Go to **Settings**.
3. Open **Actions**.
4. Make sure GitHub Actions are allowed.
5. Add a workflow file in `.github/workflows/`.
6. Connect the workflow to your release event.
7. Add your Cloudflare values and deployment steps.
8. Save the file and push it to your repository.

A basic flow often looks like this:

- release is published
- action starts promotion
- smoke tests run
- rollout continues or stops
- deployment link appears on the release page

## 🔧 Suggested release flow

A simple setup can use these stages:

- **Stage 1:** deploy to a small slice of traffic
- **Stage 2:** run smoke tests
- **Stage 3:** move to wider traffic
- **Stage 4:** finish production promotion
- **Stage 5:** roll back if a check fails

Keep the checks short and focused. Smoke tests should confirm the app loads, responds, and serves the right version.

## 🧪 Smoke test checks

Smoke tests are fast checks that look for basic health.

Good checks include:

- the Worker returns a valid response
- the main route loads
- a key API path responds
- the deployed version matches the release
- the app does not return errors on start

If a smoke test fails, stop the rollout and review the release before you continue.

## 🔁 Rollback flow

If a release causes a problem, rollback should be easy to trigger.

A rollback flow can:

- switch traffic back to the last good version
- stop the current rollout
- keep the release page link for traceability
- help you confirm the service is stable again

This keeps a bad release from spreading to all users.

## 🔗 Release-page deployment links

This project can place deployment links on the GitHub Release page.

Useful links can point to:

- the rollout stage
- the smoke test result
- the live Worker URL
- the rollback step
- the final production state

This helps you track what happened during promotion without digging through logs.

## 🛠️ Example workflow shape

A common GitHub Actions flow may include:

- `on: release`
- checkout the repo
- read the release tag
- deploy the Worker
- run a smoke test
- promote or roll back
- post links to the release page

The exact steps depend on how you manage your Cloudflare setup and release process.

## 🔐 Permissions and access

Make sure your workflow has access to the tools it needs.

You may need:

- GitHub token access for release updates
- Cloudflare API access for Worker deployment
- permission to edit release assets or release notes
- secrets stored in GitHub repository settings

Keep secret values out of the workflow file. Store them in GitHub Secrets.

## 🧰 Troubleshooting

If the rollout does not start, check:

- the release was published, not just drafted
- the workflow file is in the right path
- GitHub Actions are enabled
- your secrets are set
- the Cloudflare account and Worker names match
- the smoke test endpoint returns a clean response

If the release page does not show links, check:

- the workflow has permission to update the release
- the release event fired
- the action ran to completion
- the link format is valid

If rollback does not happen, check:

- the workflow can reach Cloudflare
- the last good version is still available
- the action has the right access rights

## 📁 Typical project layout

A simple repository may use this shape:

- `.github/workflows/` for the Action workflow
- `src/` for Worker code
- `tests/` for smoke checks
- `wrangler.toml` for Cloudflare Worker settings
- `README.md` for setup notes and release flow details

## 🌍 Best use cases

This tool fits well when you want to:

- release a Cloudflare Worker with control
- reduce risk during production updates
- add smoke test gates before full rollout
- keep a visible record of deployment steps
- support rollback during release promotion

## 🧩 Topics

- cloudflare
- cloudflare-workers
- deployment-automation
- devops
- github-action
- github-actions
- progressive-delivery
- release-automation
- rollback
- smoke-tests
- workers
- wrangler