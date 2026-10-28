import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const base = process.env.DEPLOYMENT_URL || 'https://sentinel-ecu.pages.dev';
const expected = process.env.EXPECTED_COMMIT;
assert.match(expected || '', /^[a-f0-9]{40}$/, 'EXPECTED_COMMIT must be the full tested Git SHA.');
assert.equal(new URL(base).protocol, 'https:', 'Deployment checks require HTTPS.');
let deployed = false;
for (let attempt = 0; attempt < 72; attempt++) {
  try {
    const response = await fetch(`${base}/_release.json?commit=${expected}&attempt=${attempt}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (response.ok && (await response.json()).commit === expected) { deployed = true; break; }
  } catch { /* The previous release may still be serving during deployment. */ }
  console.log(`Waiting for tested commit ${expected.slice(0, 7)} (${attempt + 1}/72).`);
  await delay(10000);
}
assert.ok(deployed, 'Cloudflare did not publish the tested commit within the deployment window. Inspect its build logs; do not report success.');
const assets = [
  ['/', 'text/html'], ['/simulator/', 'text/html'], ['/how-it-works/', 'text/html'],
  ['/laboratory/', 'text/html'], ['/design/sentinel.js', 'javascript'], ['/design/session-adapter.js', 'javascript'],
  ['/design/walkthrough-worker.js', 'javascript'], ['/design/sentinel.css', 'text/css'], ['/design/production.css', 'text/css'],
  ['/attack-scenarios/', 'text/html'], ['/validation/', 'text/html'],
  ['/public.css', 'text/css'], ['/public.js', 'javascript'], ['/sitemap.xml', 'xml'], ['/robots.txt', 'text/plain'],
  ['/app.js', 'javascript'], ['/browser-runtime.js', 'javascript'],
  ['/browser-worker.js', 'javascript'], ['/browser-validation.js', 'javascript'],
  ['/engine/simulation.js', 'javascript'], ['/engine/datasets.js', 'javascript'],
  ['/engine/browser-session.js', 'javascript'], ['/engine/experiments.js', 'javascript'],
  ['/engine/presentation-observer.js', 'javascript'],
  ['/styles.css', 'text/css'], ['/workbench.css', 'text/css'], ['/presentation.css', 'text/css'], ['/vendor/tabler.min.css', 'text/css'],
];
for (const [path, type] of assets) {
  const response = await fetch(`${base}${path}?release=${expected}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `${path} did not load.`);
  assert.ok(response.headers.get('content-type')?.includes(type), `${path} has an unexpected content type.`);
  const body = await response.text();
  assert.ok(body.length > 0, `${path} is empty.`);
  if (path === '/simulator/') {
    assert.ok(body.includes('data-runtime="browser"'), 'The live site is not the browser edition.');
    assert.ok(response.headers.get('content-security-policy')?.includes("worker-src 'self'"), 'Worker security policy missing.');
  }
}
const missing = await fetch(`${base}/missing-${expected}.js`, { signal: AbortSignal.timeout(15000) });
assert.equal(missing.status, 404, 'Missing JavaScript assets must not return the app HTML.');
console.log(`Verified production release ${expected} at ${base}.`);
