import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, SCENARIOS } from '../src/simulation.js';
import { observePresentation, presentationSnapshot } from '../src/presentation-observer.js';

test('presentation snapshots cannot mutate recorded evidence', () => {
  const sim = observePresentation(new Simulation({ seed: 42 })); sim.advance(300);
  const before = sim.getFrames();
  const info = presentationSnapshot(sim);
  info.samples[0].data[0] = 255;
  info.samples[0].reasons.push('untrusted UI edit');
  info.drops.ingress = 1000;
  assert.deepEqual(sim.getFrames(), before);
  assert.equal(presentationSnapshot(sim).drops.ingress, 0);
});

for (const { id } of SCENARIOS) test(`presentation preserves ${id} decisions and safety`, () => {
  const original = new Simulation({ seed: 42, profile: 'urban' });
  const observed = observePresentation(new Simulation({ seed: 42, profile: 'urban' }));
  for (const sim of [original, observed]) {
    sim.advance(1500);
    sim.injectAttack({ type: id, targetId: id === 'flooding' ? 0x300 : 0x120, intensity: 5, durationMs: 1500 });
    sim.advance(2500);
  }
  assert.deepEqual(observed.getFrames(), original.getFrames());
  assert.deepEqual(observed.snapshot().safety, original.snapshot().safety);
  assert.deepEqual(observed.snapshot().vehicle, original.snapshot().vehicle);
  assert.equal(observed.snapshot().risk, original.snapshot().risk);
  const presentation = presentationSnapshot(observed);
  const metrics = observed.snapshot().metrics;
  assert.equal(presentation.drops.ingress + presentation.drops.egress, metrics.dropped);
  assert.equal(presentation.blockReasons.reduce((n, [,count]) => n + count, 0), metrics.blocked);
  assert.ok(presentation.samples.length <= 24 && presentation.notable.length <= 60);
  const known = new Map(observed.getFrames().map(f => [f.seq, f]));
  for (const frame of presentation.samples) {
    // A sampled frame can predate the main bounded window; it remains a real record.
    if (known.has(frame.seq)) assert.deepEqual(frame, known.get(frame.seq));
  }
  observed.reset({ seed: 42, profile: 'urban' });
  assert.deepEqual(presentationSnapshot(observed), { drops: { ingress: 0, egress: 0 }, blockReasons: [], samples: [], notable: [] });
});
