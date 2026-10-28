import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { writePublicPages } from './public-pages.js';
const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
let commit = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA;
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { commit = 'local'; }
}
await mkdir(out, { recursive: true });
await writeFile(new URL('_release.json', out), JSON.stringify({ version: '1.0.0', commit }));
await mkdir(new URL('engine/', out), { recursive: true });
await writePublicPages();
await cp(new URL('web/', root), out, { recursive: true });
for (const file of ['simulation.js', 'datasets.js', 'experiments.js', 'browser-session.js', 'presentation-observer.js']) {
  await cp(new URL(`src/${file}`, root), new URL(`engine/${file}`, out));
}
// Approved presentation and the retained classic laboratory share the same APIs.
const browserHTML = html => html.replace('<html lang="en">', '<html lang="en" data-runtime="browser">');
const html = browserHTML(await readFile(new URL('web/signal.html', root), 'utf8'));
await mkdir(new URL('simulator/', out), { recursive: true });
await mkdir(new URL('laboratory/', out), { recursive: true });
await writeFile(new URL('index.html', out), html);
await writeFile(new URL('simulator/index.html', out), html.replace('href="https://sentinel-ecu.pages.dev/"', 'href="https://sentinel-ecu.pages.dev/simulator/"'));
await writeFile(new URL('laboratory/index.html', out), browserHTML(await readFile(new URL('web/index.html', root), 'utf8')));
for (const slug of ['how-it-works', 'attack-scenarios', 'validation']) {
  await mkdir(new URL(`${slug}/`, out), { recursive: true });
  await cp(new URL(`web/${slug}.html`, root), new URL(`${slug}/index.html`, out));
}
await writeFile(new URL('_redirects', out), '/intro.html / 301\n/how-it-works.html /how-it-works/ 301\n/attack-scenarios.html /attack-scenarios/ 301\n/validation.html /validation/ 301\n');
await writeFile(new URL('_headers', out), `/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cache-Control: public, max-age=0, must-revalidate
`);
// Real missing files must be 404s, not HTML masquerading as a worker script.
await writeFile(new URL('404.html', out), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Not found · Sentinel ECU</title><h1>Page not found</h1><a href="/">Open Sentinel ECU</a></html>');
console.log('Cloudflare Pages site built in dist/ (no session data or credentials included).');
