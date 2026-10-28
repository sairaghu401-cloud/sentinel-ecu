# Publishing Sentinel ECU

Production site: **https://sentinel-ecu.pages.dev/**. Source: **https://github.com/sairaghu401-cloud/sentinel-ecu**. Cloudflare Pages automatically publishes the repository's `main` branch. GitHub Actions tests each commit and then verifies the deployed release (see [Release pipeline](#release-pipeline)). Cloudflare deployment runs independently of CI and can finish before the checks.

The public browser edition runs the same simulation, trace parser, and acceptance suite as the local Node edition. Cloudflare Pages serves only application assets. Every browser tab owns an independent Web Worker session. A second worker runs validation without freezing the workbench.

No CAN traces, simulated session data, or credentials are sent to a simulation server. Imported files are processed in the browser. Reloading or closing a tab discards that session; use CSV/report export first. Background browser throttling may slow simulated time relative to wall time. Simulated CAN timing remains deterministic. This is a software laboratory, not a hardware or safety-certified system.

## Build and preview

Requires Node 22 or newer. No runtime dependencies or secrets are needed.

```sh
npm run release:check
npm run preview
```

`release:check` runs the syntax check, unit tests, synthetic validation and site build, the same command CI runs. Open `http://127.0.0.1:8788`. The original persistent local edition remains available with `npm start` on port 8787. The browser checks need Playwright's Chromium: run `npm ci`, then `npx playwright install chromium`, then `npm run test:browser`. Commit `package-lock.json`; CI installs from it with `npm ci`.

## Release pipeline

`.github/workflows/ci.yml` runs on every push and pull request to `main`, and can also be started by hand from the Actions tab.

1. **Simulation** runs `npm run release:check` on Ubuntu and Windows with Node 22 and 24. It uploads each validation report.
2. **Browser workflows** installs from the lockfile, builds `dist/` and runs `npm run test:browser` in Chromium. It uploads the browser evidence and the tested `dist/`.
3. **Verify Cloudflare release** runs only for `main`, never for pull requests, and only after both jobs pass. If `main` has moved on since the run started, it skips verification so the newer commit's own run verifies the site. The job does not push branches or initiate deployment.
4. The same job then runs `npm run verify:deployment`. It polls `https://sentinel-ecu.pages.dev/_release.json` every 10 seconds, for up to 12 minutes, until the site reports that exact commit. It then checks that each public asset loads with the right content type, that the page is the browser edition with its worker security policy, and that a missing script returns 404. If Cloudflare never publishes the commit, the job fails.

`_release.json` is written by `npm run build` from Cloudflare's `CF_PAGES_COMMIT_SHA` (or `GITHUB_SHA`, or the local Git commit). It holds only the version and commit.

The existing Cloudflare Git integration is the deployment mechanism. CI is a verification step, not a pre-deployment gate. Run checks before publishing; for future changes, use a tested pull request before merging to `main`. The `production` branch is not used by this workflow.

## Cloudflare Pages

Project `sentinel-ecu`, connected to this GitHub repository, with production branch `main`, build command `npm run build` and output directory `dist`. No environment variables or deployment tokens are needed in GitHub Actions. Other branches may create preview deployments.

`dist/_headers` supplies a strict same-origin content security policy and browser protections. `404.html` prevents missing worker files being silently served as the application HTML. Assets revalidate on reload to avoid mixed engine/UI releases. No functions, paid services, database, public laptop tunnel, or shared mutable backend are required.

## Verify and roll back

CI already checks the release and the public assets. To repeat that check by hand, run the command below from Git Bash or another POSIX shell; `DEPLOYMENT_URL` defaults to the production site and must be HTTPS:

```sh
EXPECTED_COMMIT=$(git rev-parse origin/main) npm run verify:deployment
```

For a manual walkthrough, open the production HTTPS URL in a fresh tab. Confirm “Browser simulation ready”, run traffic, inject low and maximum intensity attacks, export CSV and JSON, import a trace, and run all 12 validation scenarios. Confirm a second tab begins paused at zero and remains independent. Check the browser console for errors.

Keep the previous successful Cloudflare deployment available. If a release fails, roll back to it in the Cloudflare dashboard. Then revert the offending commit on `main`, and let Cloudflare deploy the revert and CI verify it. Re-running GitHub Actions repeats checks and verification; retry a Cloudflare build from its dashboard when an actual redeployment is required.

## Publication boundary

Only source, synthetic examples, tests, design assets/licenses, documentation, and reproducible synthetic evidence belong in Git. `data/`, local screenshots/backups, `.env` files, build output, Cloudflare state, and archives are ignored. Never commit account tokens. Third-party font/theme licenses are in `docs/licenses/`.
