import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, SIGNALS, SCENARIOS } from '../src/simulation.js';

const brake = (timestampMs, counter, primary = 0, label = 'normal') => ({ timestampMs, id: 0x120, data: [Math.round(primary * 100) & 255, Math.round(primary * 100) >>> 8, 216, 14, 0, 0, 0, counter & 255], label });
const advance = (simulation, duration) => { while (duration > 0) { const step = Math.min(10000, duration); simulation.advance(step); duration -= step; } };
const stable = simulation => {
  const state = simulation.snapshot();
  delete state.metrics.processingP50Us; delete state.metrics.processingP95Us;
  return state;
};
const decisions = simulation => simulation.getFrames().map(({ label, attackType, ...frame }) => frame);

test('starts paused with a trained, separate model and complete schema', () => {
  const simulation = new Simulation(); const state = simulation.snapshot();
  assert.equal(state.running, false); assert.equal(state.timeMs, 0); assert.equal(state.status, 'OBSERVE');
  assert.equal(state.safety.state, 'NORMAL'); assert.equal(state.vehicle.motorEnabled, true);
  assert.equal(state.metrics.received, 0); assert.equal(state.metrics.precision, null);
  assert.equal(state.analyst.trained, true); assert.ok(state.analyst.trainingSamples > 10000);
  assert.equal(SIGNALS.length, 6); assert.equal(SCENARIOS.length, 6);
  assert.notEqual(simulation.report().provenance.trainingSeed, state.seed);
  assert.equal(simulation.report().configuration.safetyAcknowledgmentMs, 60);
});

test('public controls reject invalid values before changing simulation state', () => {
  assert.throws(() => new Simulation({ seed: -1 }), RangeError);
  assert.throws(() => new Simulation({ seed: 2 ** 32 }), RangeError);
  assert.throws(() => new Simulation({ profile: 'race' }), RangeError);
  const simulation = new Simulation();
  for (const value of [0, -1, 10001, 1.5, NaN, '100']) assert.throws(() => simulation.advance(value), RangeError);
  for (const value of [0, 3, Infinity, '2']) assert.throws(() => simulation.setSpeed(value), RangeError);
  for (const method of ['setAnalyst', 'setRunning']) assert.throws(() => simulation[method](1), TypeError);
  for (const attack of [{ type: 'unknown' }, { type: 'replay', targetId: 2048 }, { type: 'replay', durationMs: 99 }, { type: 'replay', intensity: 6 }, { type: 'stealth', targetId: 1 }]) assert.throws(() => simulation.injectAttack(attack), RangeError);
  assert.throws(() => simulation.requestRecovery(), RangeError);
  assert.throws(() => simulation.reset({ seed: -1 }), RangeError);
  assert.equal(simulation.snapshot().timeMs, 0); assert.equal(simulation.snapshot().activeAttacks.length, 0);
});

for (const profile of ['urban', 'highway']) {
  test(`two minutes of clean ${profile} traffic have no false positives or unexplained loss`, () => {
    const simulation = new Simulation({ profile, seed: 19 }); advance(simulation, 120000);
    const state = simulation.snapshot();
    assert.equal(state.metrics.received, 21000); assert.equal(state.metrics.forwarded, 21000);
    assert.equal(state.metrics.fp, 0); assert.equal(state.metrics.fn, 0); assert.equal(state.metrics.dropped, 0);
    assert.equal(state.status, 'OBSERVE'); assert.equal(state.safety.state, 'NORMAL');
    assert.ok(state.metrics.busLoadPct > 4 && state.metrics.busLoadPct < 6);
    assert.ok(state.metrics.processingP50Us >= 0); assert.ok(state.metrics.processingP95Us >= state.metrics.processingP50Us);
    assert.equal(state.metrics.simulatedLatencyP95Us, 574);
    const report = simulation.report();
    assert.equal(report.frames.length, state.limits.frameCapacity); assert.equal(report.retention.omittedFrames, 1000);
    assert.equal(state.frames.length, 160);
    assert.ok(report.frames.every((frame, index, list) => index === 0 || frame.seq > list[index - 1].seq));
    assert.ok(state.frames.every((frame, index, list) => index === 0 || frame.seq < list[index - 1].seq));
  });
}

test('same seed and commands are deterministic across different advance chunk sizes', () => {
  const first = new Simulation({ seed: 123 }); const second = new Simulation({ seed: 123 });
  first.advance(2000); for (let i = 0; i < 200; i++) second.advance(10);
  first.injectAttack({ type: 'stealth', durationMs: 2000 }); second.injectAttack({ type: 'stealth', durationMs: 2000 });
  first.advance(4000); for (let i = 0; i < 400; i++) second.advance(10);
  assert.deepEqual(stable(first), stable(second)); assert.deepEqual(first.getFrames(), second.getFrames());
  const different = new Simulation({ seed: 124 }); different.advance(2000);
  assert.notDeepEqual(first.getFrames().slice(0, 300).map(frame => frame.data), different.getFrames().slice(0, 300).map(frame => frame.data));
});

test('snapshot and exports do not expose mutable internal evidence', () => {
  const simulation = new Simulation(); simulation.advance(1000);
  const before = stable(simulation); const copy = simulation.snapshot(); const report = simulation.report();
  copy.frames[0].data[0] = 255; copy.frames[0].reasons.push('tampered'); copy.events[0].detail = 'tampered';
  copy.series[0].risk = 99; copy.safety.state = 'DEGRADED'; copy.vehicle.motorEnabled = false;
  report.frames[0].data[0] = 255; report.events[0].detail = 'tampered';
  assert.deepEqual(stable(simulation), before);
});

test('trace validation rejects malformed frames atomically and preserves input ownership', () => {
  const simulation = new Simulation();
  const invalid = [null, {}, { ...brake(0, 0), id: 2048 }, { ...brake(0, 0), timestampMs: Infinity }, { ...brake(0, 0), data: [256] }, { ...brake(0, 0), data: Array(9).fill(0) }, { ...brake(0, 0), dlc: 7 }, { ...brake(0, 0), label: 'safe' }];
  for (const frame of invalid) assert.throws(() => simulation.ingest(frame));
  assert.equal(simulation.snapshot().metrics.received, 0);
  const frame = brake(20, 0); simulation.ingest(frame); frame.data.fill(255);
  assert.throws(() => simulation.ingest(brake(19, 1)), /monotonic/);
  simulation.advance(500);
  assert.equal(simulation.getFrames()[0].decision, 'FORWARD'); assert.equal(simulation.getFrames()[0].data[0], 0);
  assert.equal(simulation.snapshot().metrics.received, 1, 'trace advancing must not generate normal traffic');
  assert.throws(() => simulation.injectAttack({ type: 'replay' }), /Reset/);
  const used = new Simulation(); used.advance(1); assert.throws(() => used.ingest(brake(10, 0)), /fresh/);
});

test('rolling counter accepts ordinary wrap and blocks exact replay or backward jumps', () => {
  const simulation = new Simulation(); simulation.setAnalyst(false);
  for (const [time, counter] of [[0, 254], [20, 255], [40, 0], [60, 0], [80, 255], [100, 3]]) simulation.ingest(brake(time, counter));
  simulation.advance(500);
  const frames = simulation.getFrames();
  assert.deepEqual(frames.map(frame => frame.decision), ['FORWARD', 'FORWARD', 'FORWARD', 'BLOCK', 'BLOCK', 'FORWARD']);
  assert.match(frames[3].reasons.join(' '), /counter/); assert.match(frames[4].reasons.join(' '), /counter/);
});

test('allowlist, DLC, physical bounds, reserved bytes, timing and slew reject independently', () => {
  const cases = [
    [{ ...brake(0, 0), id: 0x777 }, /allowlist/],
    [{ ...brake(0, 0), data: [0, 0] }, /DLC/],
    [brake(0, 0, 101), /physical/],
    [{ ...brake(0, 0), data: [0, 0, 216, 14, 1, 0, 0, 0] }, /reserved/],
  ];
  for (const [frame, reason] of cases) {
    const simulation = new Simulation(); simulation.setAnalyst(false); simulation.ingest(frame); simulation.advance(1);
    assert.equal(simulation.getFrames()[0].decision, 'BLOCK'); assert.match(simulation.getFrames()[0].reasons.join(' '), reason);
  }
  const simulation = new Simulation(); simulation.setAnalyst(false);
  simulation.ingest(brake(0, 0)); simulation.ingest(brake(1, 1)); simulation.ingest(brake(20, 1, 90)); simulation.advance(100);
  assert.match(simulation.getFrames()[1].reasons.join(' '), /Inter-arrival/);
  assert.match(simulation.getFrames()[2].reasons.join(' '), /slew/);
});

test('ground truth and attack names cannot change gateway or analyst decisions', () => {
  const normal = new Simulation(); const labelledAttack = new Simulation();
  for (let index = 0; index < 80; index++) {
    const payload = brake(index * 20, index, index < 20 ? 0 : Math.min(90, (index - 20) * 5));
    normal.ingest({ ...payload, label: 'normal', attackType: 'normal-reference' });
    labelledAttack.ingest({ ...payload, label: 'attack', attackType: 'stealth' });
  }
  normal.advance(500); labelledAttack.advance(500);
  assert.deepEqual(decisions(normal), decisions(labelledAttack));
  assert.deepEqual(normal.snapshot().safety, labelledAttack.snapshot().safety);
  assert.deepEqual(normal.snapshot().events, labelledAttack.snapshot().events);
  assert.equal(normal.snapshot().metrics.tp, 0); assert.ok(labelledAttack.snapshot().metrics.tp > 0);
});

test('two real serialization stages impose latency and lower identifiers win arbitration', () => {
  const simulation = new Simulation(); simulation.setAnalyst(false);
  simulation.ingest({ timestampMs: 0, id: 0x500, data: [240, 10, 100, 0, 0, 0, 0, 0] });
  simulation.ingest(brake(0, 0)); simulation.advance(2);
  const [lowPriority, highPriority] = simulation.getFrames();
  assert.equal(highPriority.latencyUs, 574); assert.ok(lowPriority.latencyUs > highPriority.latencyUs);
  assert.equal(simulation.snapshot().metrics.queueDepth, 0); assert.equal(simulation.snapshot().metrics.received, 2);
});

test('flooding is constrained by bit budget and bounded queues; drops are not detections', () => {
  const simulation = new Simulation(); simulation.advance(1000);
  simulation.injectAttack({ type: 'flooding', durationMs: 2000, intensity: 5 }); simulation.advance(1000);
  const state = simulation.snapshot();
  assert.ok(state.metrics.dropped > 0); assert.ok(state.metrics.busLoadPct <= 100 && state.metrics.busLoadPct > 99);
  assert.ok(state.metrics.queueDepth <= 256);
  assert.equal(state.metrics.received, state.metrics.forwarded + state.metrics.blocked + state.metrics.dropped + state.metrics.queueDepth);
  const completedInLastSecond = simulation.getFrames().filter(frame => frame.timestampMs >= 1000 && frame.decision !== 'DROP').length;
  assert.ok(completedInLastSecond <= 3600, '139-bit frames cannot exceed ~3597 frames per second at500kbit/s');
  const attackDrops = simulation.getFrames().filter(frame => frame.label === 'attack' && frame.decision === 'DROP').length;
  assert.ok(attackDrops > 0); assert.ok(state.metrics.fn >= attackDrops);
  assert.equal(state.metrics.tp, simulation.getFrames().filter(frame => frame.label === 'attack' && frame.decision === 'BLOCK').length);
});

test('finite evidence, classifier queues and cooldown maps survive sustained offered overload', () => {
  const simulation = new Simulation(); simulation.advance(1000);
  simulation.injectAttack({ type: 'flooding', durationMs: 3000, intensity: 5 }); simulation.advance(3000);
  simulation.injectAttack({ type: 'fuzzing', durationMs: 1000, intensity: 5 }); simulation.advance(1500);
  const report = simulation.report();
  assert.equal(report.frames.length, report.limits.frameCapacity);
  assert.ok(report.events.length <= report.limits.eventCapacity);
  assert.ok(simulation.analystPending.length <= report.configuration.analystQueueCapacity);
  assert.ok(simulation.alertTimes.size <= 128); assert.ok(simulation.rateWindows.size <= 6);
  assert.ok([...simulation.rateWindows.values()].every(window => window.length <= 128));
  assert.ok(report.retention.omittedFrames > 0);
  assert.ok(report.risk >= 0 && report.risk <= 100);
  assert.equal(new Set(report.frames.map(frame => frame.seq)).size, report.frames.length);
});

test('statistical analyst is delayed and uses multiple observations before holding traffic', () => {
  const simulation = new Simulation();
  for (let index = 0; index < 8; index++) simulation.ingest(brake(index * 20, index, 90, 'attack'));
  simulation.advance(200);
  const frames = simulation.getFrames(); const firstBlock = frames.find(frame => frame.decision === 'BLOCK');
  assert.ok(firstBlock); assert.ok(firstBlock.timestampMs >= 80);
  assert.equal(frames[0].decision, 'FORWARD');
  assert.match(firstBlock.reasons.join(' '), /Analyst hold/);
  assert.ok(firstBlock.anomalyScore > 0.75);
  const analyst = simulation.snapshot().analyst;
  assert.equal(analyst.processed, 8);
  assert.equal(analyst.outliers, 8);
  assert.ok(analyst.activeHolds.some(hold => hold.id === 0x120));
});

test('analyst telemetry follows delayed observations, stops offline, and cannot mutate the model', () => {
  const simulation = new Simulation();
  simulation.ingest(brake(0, 0, 90));
  assert.equal(simulation.snapshot().analyst.processed, 0);
  simulation.advance(40);
  assert.equal(simulation.snapshot().analyst.processed, 0, 'CAN serialization precedes the 40 ms analyst delay');
  simulation.advance(1);
  const snapshot = simulation.snapshot();
  assert.equal(snapshot.analyst.processed, 1);
  assert.equal(snapshot.analyst.outliers, 1);
  snapshot.analyst.lastObservation.id = 0x777;
  snapshot.analyst.activeHolds.push({ id: 0x777, untilMs: 999999 });
  assert.equal(simulation.snapshot().analyst.lastObservation.id, 0x120);
  assert.deepEqual(simulation.snapshot().analyst.activeHolds, []);
  simulation.setAnalyst(false);
  simulation.ingest(brake(60, 1, 90)); simulation.advance(100);
  assert.equal(simulation.snapshot().analyst.processed, 1);
  simulation.reset();
  assert.equal(simulation.snapshot().analyst.processed, 0);
  assert.equal(simulation.snapshot().analyst.lastObservation, null);
});

test('maximum battery flood is filtered without claiming a payload anomaly or critical-signal shutdown', () => {
  const simulation = new Simulation(); simulation.advance(2000);
  simulation.injectAttack({ type: 'flooding', targetId: 0x300, durationMs: 30000, intensity: 5 });
  simulation.advance(10000);
  const state = simulation.snapshot();
  assert.equal(state.status, 'FILTER'); assert.equal(state.risk, 100);
  assert.ok(state.metrics.blocked > 0); assert.ok(state.metrics.dropped > 0);
  assert.equal(state.safety.state, 'NORMAL'); assert.equal(state.vehicle.motorEnabled, true);
  assert.deepEqual(state.safety.requestCriteria, { elevatedRisk: true, sustainedThreat: true, criticalSignalEvidence: false });
  assert.ok(state.analyst.processed > 1000); assert.equal(state.analyst.outliers, 0);
  assert.deepEqual(state.analyst.activeHolds, []);
});

test('Pi disconnect leaves gateway rules alive and exposes schema-valid drift evasion', () => {
  const simulation = new Simulation(); simulation.setAnalyst(false); simulation.advance(2000);
  simulation.injectAttack({ type: 'stealth', durationMs: 1000, intensity: 2 }); simulation.advance(1000);
  assert.equal(simulation.getFrames().filter(frame => frame.label === 'attack' && frame.decision === 'BLOCK').length, 0);
  assert.equal(simulation.snapshot().safety.state, 'NORMAL');
  simulation.injectAttack({ type: 'payload', durationMs: 1000 }); simulation.advance(1000);
  assert.ok(simulation.getFrames().some(frame => frame.attackType === 'payload' && frame.decision === 'BLOCK'));
  assert.equal(simulation.snapshot().analyst.connected, false); assert.equal(simulation.snapshot().safety.state, 'DEGRADED');
});

test('SPRT computes likelihood ratios from observed evidence and resets at decision boundaries', () => {
  const simulation = new Simulation(); simulation.setAnalyst(false);
  simulation.ingest({ timestampMs: 0, id: 0x777, data: [], label: 'unknown' }); simulation.advance(100);
  assert.ok(Math.abs(simulation.snapshot().sprt.value - Math.log(0.65 / 0.01)) < 1e-12);
  assert.equal(simulation.report().configuration.sprt.decisions.attack, 0);
  simulation.ingest({ timestampMs: 100, id: 0x777, data: [], label: 'unknown' }); simulation.advance(100);
  assert.equal(simulation.report().configuration.sprt.decisions.attack, 1);
  assert.equal(simulation.snapshot().sprt.value, 0);
  assert.equal(simulation.snapshot().safety.state, 'NORMAL', 'unknown noncritical evidence alone cannot request motor degradation');
});

test('safety request, delayed acknowledgment and explicit eligible recovery are distinct states', () => {
  const simulation = new Simulation(); simulation.advance(2000);
  simulation.injectAttack({ type: 'payload', durationMs: 500, intensity: 5 }); simulation.advance(500);
  assert.equal(simulation.snapshot().safety.state, 'REQUESTED'); assert.equal(simulation.snapshot().vehicle.motorEnabled, true);
  simulation.advance(59); assert.equal(simulation.snapshot().safety.state, 'REQUESTED');
  simulation.advance(1); assert.equal(simulation.snapshot().safety.state, 'DEGRADED'); assert.equal(simulation.snapshot().vehicle.motorEnabled, false);
  assert.equal(simulation.snapshot().safety.activatedAtMs - simulation.snapshot().safety.requestedAtMs, 60);
  assert.throws(() => simulation.requestRecovery(), /2500 ms/);
  simulation.clearAttacks(); simulation.advance(6000);
  assert.equal(simulation.snapshot().safety.state, 'DEGRADED', 'quiet time cannot silently clear the latch');
  assert.equal(simulation.snapshot().safety.recoveryEligible, true);
  simulation.requestRecovery(); simulation.advance(1000);
  assert.equal(simulation.snapshot().safety.state, 'NORMAL'); assert.equal(simulation.snapshot().vehicle.motorEnabled, true);
  assert.equal(simulation.snapshot().status, 'OBSERVE');
});

test('post-congestion counter state resynchronizes and recovery becomes eligible', () => {
  const simulation = new Simulation(); simulation.advance(2000);
  simulation.injectAttack({ type: 'flooding', durationMs: 2000, intensity: 2 }); simulation.advance(8000);
  assert.equal(simulation.snapshot().safety.recoveryEligible, true);
  assert.ok(simulation.getFrames().filter(frame => frame.timestampMs >= 8000).every(frame => frame.decision === 'FORWARD'));
  simulation.requestRecovery(); assert.equal(simulation.snapshot().vehicle.motorEnabled, true);
});

test('low-criticality payload compromise cannot independently request degraded vehicle operation', () => {
  const simulation = new Simulation(); simulation.advance(1000);
  simulation.injectAttack({ type: 'payload', targetId: 0x400, durationMs: 3000 }); simulation.advance(3000);
  assert.ok(simulation.snapshot().metrics.blocked > 0); assert.equal(simulation.snapshot().safety.state, 'NORMAL');
});

test('large trace gaps are bounded, preserve a clean sequential trial, and create no synthetic traffic', () => {
  const simulation = new Simulation(); simulation.ingest(brake(0, 0));
  simulation.ingest(brake(1_000_000_000, 1)); simulation.advance(500);
  const state = simulation.snapshot();
  assert.equal(state.metrics.received, 2); assert.equal(state.metrics.forwarded, 2); assert.equal(state.risk, 0);
  assert.equal(state.series.length, state.limits.seriesCapacity); assert.equal(state.timeMs, 1_000_000_500);
  assert.ok(state.series.every((point, index, list) => index === 0 || point.timeMs > list[index - 1].timeMs));
  assert.equal(state.sprt.value, 0);
});

test('reset rebuilds reproducible state, discards attacks/evidence and pauses the run', () => {
  const simulation = new Simulation(); simulation.setRunning(true); simulation.setSpeed(5); simulation.setAnalyst(false);
  simulation.injectAttack({ type: 'replay' }); simulation.advance(1000); simulation.reset({ seed: 43, profile: 'highway' });
  assert.deepEqual(stable(simulation), stable(new Simulation({ seed: 43, profile: 'highway' })));
});
