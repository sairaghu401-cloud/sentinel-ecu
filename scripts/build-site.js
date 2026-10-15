import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
await mkdir(new URL('engine/', out), { recursive: true });
await cp(new URL('web/', root), out, { recursive: true });
for (const file of ['simulation.js', 'datasets.js', 'experiments.js', 'browser-session.js']) {
  await cp(new URL(`src/${file}`, root), new URL(`engine/${file}`, out));
}
const html = await readFile(new URL('index.html', out), 'utf8');
await writeFile(new URL('index.html', out), html.replace('<html lang="en">', '<html lang="en" data-runtime="browser">'));
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
