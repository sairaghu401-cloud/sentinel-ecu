import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, INTENSITY_PROFILES, describeAttackIntensity } from '../src/simulation.js';

function run(type, intensity, targetId = 0x300) {
  const sim = new Simulation(); sim.advance(1000);
  sim.injectAttack({ type, intensity, targetId, durationMs: 1000 });
  sim.advance(1000); sim.advance(100); // Drain queued frames after source completion.
  return sim;
}

test('five flood levels offer distinct exact traffic rates; low pressure does not imply saturation', () => {
  for (const profile of INTENSITY_PROFILES) {
    const sim = run('flooding', profile.level);
    assert.equal(sim.getFrames().filter(frame => frame.label === 'attack').length, profile.floodFramesPerSecond);
    if (profile.level === 1) assert.equal(sim.snapshot().metrics.dropped, 0);
    if (profile.level === 5) assert.ok(sim.snapshot().metrics.dropped > 0);
  }
});

test('spoofing, replay and fuzzing pace actual injections at each configured level', () => {
  for (const type of ['spoofing', 'replay', 'fuzzing']) {
    for (const profile of INTENSITY_PROFILES) {
      const sim = run(type, profile.level);
      assert.equal(sim.getFrames().filter(frame => frame.label === 'attack').length, Math.ceil(1000 / profile.frameIntervalMs));
    }
  }
});

test('payload intensity changes the fraction corrupted without labelling untouched target frames as attacks', () => {
  for (const profile of INTENSITY_PROFILES) {
    const sim = run('payload', profile.level, 0x120);
    const target = sim.getFrames().filter(frame => frame.id === 0x120 && frame.timestampMs >= 1000 && frame.timestampMs < 2000);
    assert.equal(target.length, 50);
    assert.equal(target.filter(frame => frame.label === 'attack').length, Math.floor(50 * profile.payloadPercent / 100));
    for (const frame of target) {
      const primary = (frame.data[0] + 256 * frame.data[1]) / 100;
      assert.equal(primary === 450, frame.label === 'attack');
    }
  }
});

test('stealth levels move payloads progressively faster while preserving normal transmission cadence', () => {
  const values = INTENSITY_PROFILES.map(profile => {
    const sim = run('stealth', profile.level);
    const attacks = sim.getFrames().filter(frame => frame.label === 'attack');
    assert.equal(attacks.length, 10);
    const at = attacks.find(frame => frame.timestampMs >= 1500);
    return (at.data[0] + 256 * at.data[1]) / 100;
  });
  for (let index = 1; index < 4; index++) assert.ok(values[index] > values[index - 1]);
  assert.equal(values[3], 98); assert.equal(values[4], 98);
});

test('active attack metadata and event history retain the chosen level and its calibrated meaning', () => {
  const sim = new Simulation(); sim.injectAttack({ type: 'payload', intensity: 1 });
  const snapshot = sim.snapshot();
  assert.equal(snapshot.activeAttacks[0].intensity, 1);
  assert.deepEqual(snapshot.activeAttacks[0].strength, describeAttackIntensity('payload', 1));
  assert.match(snapshot.events[0].detail, /Intensity 1\/5 \(Low\): 10%/);
  snapshot.activeAttacks[0].strength.label = 'tampered';
  assert.equal(sim.snapshot().activeAttacks[0].strength.label, 'Low');
});
