import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser-session.js';
import { Simulation } from '../src/simulation.js';

test('browser session uses the same model decisions and metrics as Node', () => {
  const session = new BrowserSession();
  const reference = new Simulation({ seed: 42, profile: 'urban' });
  const attack = { type: 'flooding', targetId: 0x300, intensity: 5, durationMs: 5000 };
  session.request('/api/attack', attack); reference.injectAttack(attack);
  session.request('/api/control', { action: 'step', milliseconds: 5000 }); reference.advance(5000);
  assert.deepEqual(session.sim.getFrames().map(f => [f.timestampMs, f.id, f.decision, f.reason]), reference.getFrames().map(f => [f.timestampMs, f.id, f.decision, f.reason]));
  assert.equal(session.snapshot().risk, reference.snapshot().risk);
  assert.equal(session.snapshot().metrics.dropped, reference.snapshot().metrics.dropped);
});
test('browser tabs isolate state and reset safely', () => {
  const one = new BrowserSession(), two = new BrowserSession();
  one.request('/api/control', { action: 'start' }); one.tick();
  assert.equal(one.snapshot().timeMs, 50); assert.equal(two.snapshot().timeMs, 0);
  assert.notEqual(one.session.id, two.session.id);
  assert.throws(() => one.request('/api/control', { action: 'step' }), /Pause/);
  assert.throws(() => one.request('/api/control', { action: 'reset', seed: -1 }), /Seed/);
  assert.equal(one.snapshot().timeMs, 50);
  one.request('/api/control', { action: 'reset', seed: 7 });
  assert.equal(one.snapshot().seed, 7); assert.equal(one.snapshot().running, false);
});
test('browser imports are atomic, exports preserve provenance, replay locks controls', () => {
  const session = new BrowserSession();
  session.request('/api/control', { action: 'step', milliseconds: 100 });
  const csv = session.request('/api/export', { format: 'csv' });
  assert.match(csv.filename, /\.csv$/);
  assert.throws(() => session.request('/api/import', { text: 'bad', format: 'csv' }));
  assert.equal(session.snapshot().timeMs, 100);
  const imported = session.request('/api/import', { text: csv.content, format: 'csv' });
  assert.ok(imported.summary.frames > 0);
  assert.equal(imported.snapshot.source, 'imported');
  assert.throws(() => session.request('/api/control', { action: 'start' }), /Reset/);
  assert.throws(() => session.request('/api/attack', {}), /Reset/);
  const report = JSON.parse(session.request('/api/export', { format: 'json' }).content);
  assert.equal(report.provenance.environment.runtime, 'browser-worker');
  assert.equal(report.provenance.kind, 'imported');
  assert.equal(report.frames.length, imported.summary.frames);
});
