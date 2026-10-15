# Publishing Sentinel ECU

The public browser edition runs the same simulation, trace parser, and acceptance suite as the local Node edition. Cloudflare Pages serves only application assets. Every browser tab owns an independent Web Worker session. A second worker runs validation without freezing the workbench.

No CAN traces, simulated session data, or credentials are sent to a simulation server. Imported files are processed in the browser. Reloading or closing a tab discards that session; use CSV/report export first. Background browser throttling may slow simulated time relative to wall time. Simulated CAN timing remains deterministic. This is a software laboratory, not a hardware or safety-certified system.

## Build and preview

Requires Node 22 or newer. No runtime dependencies or secrets are needed.

```sh
npm test
npm run validate
npm run build
npm run preview
```

Open `http://127.0.0.1:8788`. The original persistent local edition remains available with `npm start` on port 8787.

## Cloudflare Pages

Use project name `sentinel-ecu` (or an available alternative), production branch `main`, build command `npm run build`, and output directory `dist`. No environment variables are needed. With Git integration, subsequent pushes to main deploy automatically.

For direct upload, run `npm run build` and upload **the contents of dist**, or a zip with index.html at its root, using the Cloudflare Pages dashboard. CLI alternative:

```sh
npx wrangler login
npx wrangler pages deploy dist --project-name sentinel-ecu
```

`dist/_headers` supplies a strict same-origin content security policy and browser protections. `404.html` prevents missing worker files being silently served as the application HTML. Assets revalidate on reload to avoid mixed engine/UI releases. No functions, paid services, database, public laptop tunnel, or shared mutable backend are required.

## Verify and roll back

Open the production HTTPS URL in a fresh tab. Confirm “Browser simulation ready”, run traffic, inject low and maximum intensity attacks, export CSV and JSON, import a trace, and run all 12 validation scenarios. Confirm a second tab begins paused at zero and remains independent. Check the browser console for errors.

Keep the previous successful Cloudflare deployment available. If a release fails, use the dashboard's rollback for that deployment and revert the offending Git commit. Direct upload deployments must be updated explicitly; pushing GitHub alone does not deploy them.

## Publication boundary

Only source, synthetic examples, tests, design assets/licenses, documentation, and reproducible synthetic evidence belong in Git. `data/`, local screenshots/backups, `.env` files, build output, Cloudflare state, and archives are ignored. Never commit account tokens. Third-party font/theme licenses are in `docs/licenses/`.
