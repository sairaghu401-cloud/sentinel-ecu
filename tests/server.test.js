import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.js';

async function fixture(t, options = {}) {
  const app = await createApp({ persist: false, ...options });
  const url = await app.listen(0);
  t.after(() => app.close());
  const post = (path, input, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  return { app, url, post };
}

test('HTTP controls operate a real paused, deterministic simulation', async t => {
  const { url, post } = await fixture(t);
  assert.equal((await (await fetch(`${url}/api/health`)).json()).status, 'ok');
  let state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.running, false);
  assert.equal(state.timeMs, 0);
  state = await (await post('/api/control', { action: 'step', milliseconds: 500 })).json();
  assert.equal(state.timeMs, 500);
  assert.ok(state.metrics.received > 0);
  assert.ok(state.metrics.forwarded > 0);
  assert.equal((await post('/api/control', { action: 'speed', speed: 999 })).status, 400);
  assert.equal((await post('/api/control', { action: 'analyst', connected: 'false' })).status, 400);
  assert.equal((await post('/api/control', { action: 'recover' })).status, 409);
  assert.equal((await post('/api/control', { action: 'invented' })).status, 400);
  state = await (await post('/api/control', { action: 'reset', seed: 73, profile: 'highway' })).json();
  assert.equal(state.timeMs, 0); assert.equal(state.seed, 73); assert.equal(state.profile, 'highway');
});

test('API attack errors are recoverable and Pi loss leaves forwarding functional', async t => {
  const { url, post } = await fixture(t);
  assert.equal((await post('/api/attack', { type: 'unknown' })).status, 400);
  await post('/api/control', { action: 'analyst', connected: false });
  const result = await post('/api/attack', { type: 'payload', targetId: 0x120, durationMs: 1000, intensity: 2 });
  assert.equal(result.status, 200);
  await post('/api/control', { action: 'step', milliseconds: 2000 });
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.analyst.connected, false);
  assert.ok(state.metrics.blocked > 0); assert.ok(state.metrics.forwarded > 0);
});

test('local origin, host, body, and static routing protections are enforced', async t => {
  const { url, post } = await fixture(t);
  assert.equal((await post('/api/control', { action: 'start' }, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await fetch(`${url}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${url}/api/state`, { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(`${url}/api/control`, { method: 'POST', body: 'hello' })).status, 415);
  assert.equal((await fetch(`${url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post('/api/control', [])).status, 400);
  assert.equal((await post('/api/import', { text: 'x'.repeat(2_300_000), format: 'csv' })).status, 413);
  assert.equal((await fetch(`${url}/src/server.js`)).status, 404);
  assert.equal((await fetch(`${url}/data/test.json`)).status, 404);
  assert.equal((await fetch(`${url}/%2e%2e/package.json`)).status, 404);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('trace import is atomic, exported, and cannot accidentally start mixed synthetic traffic', async t => {
  const { url, post } = await fixture(t);
  await post('/api/control', { action: 'step', milliseconds: 100 });
  const before = await (await fetch(`${url}/api/state`)).json();
  assert.equal((await post('/api/import', { format: 'csv', text: 'timestamp_ms,id,data,label\n0,0xFFFF,01,attack' })).status, 400);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).sessionId, before.sessionId);
  const imported = await post('/api/import', { format: 'candump', text: '(1.000000) can0 777#AABB\n(1.010000) can0 777#CCDD' });
  assert.equal(imported.status, 200);
  const result = await imported.json();
  assert.equal(result.summary.frames, 2); assert.equal(result.snapshot.source, 'imported');
  assert.equal(result.snapshot.running, false); assert.equal(result.snapshot.metrics.received, 2);
  assert.equal((await post('/api/control', { action: 'start' })).status, 409);
  assert.equal((await post('/api/control', { action: 'step' })).status, 409);
  const reportResponse = await fetch(`${url}/api/export?format=json`);
  assert.match(reportResponse.headers.get('content-disposition'), /attachment/);
  const report = await reportResponse.json();
  assert.equal(report.provenance.kind, 'imported'); assert.equal(report.frames.length, 2);
  assert.ok(report.provenance.timing.includes('modeled'));
  assert.equal((await fetch(`${url}/api/export?format=html`)).status, 400);
  assert.match(await (await fetch(`${url}/api/export?format=csv`)).text(), /timestamp_ms/);
});

test('SSE sends named state events and is closed gracefully', async t => {
  const { url } = await fixture(t);
  const abort = new AbortController();
  const response = await fetch(`${url}/api/events`, { signal: abort.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: state/); assert.match(first, /"timeMs":0/);
  abort.abort();
});

test('session snapshots persist atomically across reset and shutdown', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-test-'));
  const app = await createApp({ persist: true, dataDir: dir });
  const url = await app.listen(0);
  try {
    const post = input => fetch(`${url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    await post({ action: 'step', milliseconds: 500 });
    await post({ action: 'reset', seed: 19 });
    await app.close();
    const files = await readdir(dir);
    assert.equal(files.filter(f => f.endsWith('.json')).length, 2);
    assert.equal(files.filter(f => f.endsWith('.tmp')).length, 0);
    const reports = await Promise.all(files.map(f => readFile(join(dir, f), 'utf8').then(JSON.parse)));
    assert.ok(reports.some(r => r.snapshot.timeMs === 500));
    assert.ok(reports.some(r => r.snapshot.seed === 19));
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('retention ignores untrusted session paths and malformed history metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sentinel-retention-test-'));
  const dataDir = join(dir, 'data');
  await mkdir(dataDir);
  const sentinel = join(dir, 'keep.json');
  await writeFile(sentinel, 'preserve');
  const snapshot = { seed: 42, profile: 'urban', timeMs: 0, status: 'OBSERVE', metrics: { received: 0, blocked: 0 } };
  for (let i = 0; i < 31; i++) {
    await writeFile(join(dataDir, `${randomUUID()}.json`), JSON.stringify({
      session: { id: '../keep', createdAt: new Date(i * 1000).toISOString() }, snapshot,
    }));
  }
  await writeFile(join(dataDir, `${randomUUID()}.json`), JSON.stringify({ session: { id: '../keep', createdAt: 123 }, snapshot }));
  const app = await createApp({ persist: true, dataDir });
  const url = await app.listen(0);
  try {
    const history = await (await fetch(`${url}/api/sessions`)).json();
    assert.equal(history.sessions.length, 30);
    assert.ok(history.sessions.every(s => /^[a-f0-9-]{36}$/.test(s.id)));
    await app.close();
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
    // 30 valid reports plus the ignored malformed metadata record.
    assert.equal((await readdir(dataDir)).filter(f => f.endsWith('.json')).length, 31);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
