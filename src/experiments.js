import { Simulation, SIGNALS } from './simulation.js';

const ATTACKS = ['spoofing', 'replay', 'flooding', 'fuzzing', 'payload', 'stealth'];
const KNOWN_IDS = new Set(SIGNALS.map(signal => signal.id));
const OBSERVATIONS = new WeakMap();

function observe(sim) {
  const evidence = OBSERVATIONS.get(sim) ?? { firstAttackAtMs: null, firstDetectionAtMs: null, firstSafetyActivationAtMs: null };
  // Observe every <=1 second: even flooding cannot overwrite a complete interval
  // in the 20,000-frame ring. Preserve onset evidence after old frames expire.
  for (const frame of sim.getFrames()) {
    if (frame.label !== 'attack') continue;
    evidence.firstAttackAtMs = Math.min(evidence.firstAttackAtMs ?? Infinity, frame.timestampMs);
    if (frame.decision === 'BLOCK') {
      evidence.firstDetectionAtMs = Math.min(evidence.firstDetectionAtMs ?? Infinity, frame.timestampMs + frame.latencyUs / 1000);
    }
  }
  const activation = sim.snapshot().safety.activatedAtMs;
  if (activation !== null) evidence.firstSafetyActivationAtMs = Math.min(evidence.firstSafetyActivationAtMs ?? Infinity, activation);
  OBSERVATIONS.set(sim, evidence);
  return evidence;
}

function latency(from, to) {
  return from === null || to === null || to < from ? null : Number((to - from).toFixed(6));
}

function availability(frames, score) {
  const attackDropped = frames.filter(frame => frame.label === 'attack' && frame.decision === 'DROP').length;
  const normalDropped = frames.filter(frame => frame.label === 'normal' && frame.decision === 'DROP').length;
  const inspectedAttackFrames = score.tp + score.fn - attackDropped;
  return { attackDropped, normalDropped, inspectedAttackFrames, inspectedAttackRecall: inspectedAttackFrames ? score.tp / inspectedAttackFrames : null };
}

/** Labels are read only by the evaluator, after a detector has made its decision. */
export function scoreFrames(frames, predictsAttack = frame => frame.decision === 'BLOCK') {
  let tp = 0, fp = 0, tn = 0, fn = 0, unlabelled = 0;
  for (const frame of frames) {
    if (!['normal', 'attack'].includes(frame.label)) { unlabelled++; continue; }
    const detected = Boolean(predictsAttack(frame));
    if (frame.label === 'attack') { if (detected) tp++; else fn++; }
    else if (detected) fp++;
    else tn++;
  }
  return {
    tp, fp, tn, fn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    falsePositiveRate: fp + tn ? fp / (fp + tn) : null,
    labelledFrames: tp + fp + tn + fn, unlabelled,
  };
}

function advance(sim, milliseconds) {
  let remaining = milliseconds;
  while (remaining > 0) {
    const step = Math.min(remaining, 1000);
    sim.advance(step);
    observe(sim);
    remaining -= step;
  }
}

const percent = value => value === null ? 'unavailable' : `${(value * 100).toFixed(2)}%`;
function check(name, passed, detail) { return { name, passed: Boolean(passed), detail: String(detail) }; }

function result(name, profile, attack, sim, checks, notes = []) {
  const state = sim.snapshot(), frames = sim.getFrames();
  const completedFrames = state.metrics.forwarded + state.metrics.blocked + state.metrics.dropped;
  const evictedFrames = Math.max(0, completedFrames - frames.length);
  const score = scoreFrames(frames);
  const evidence = observe(sim);
  const baseline = scoreFrames(frames, frame => !KNOWN_IDS.has(frame.id));
  const comparisonCheck = check('Identical evaluation population', score.labelledFrames === baseline.labelledFrames, `${score.labelledFrames} labelled retained frames for both detectors.`);
  const finalChecks = [...checks, comparisonCheck];
  return {
    name, profile, attack, passed: finalChecks.every(item => item.passed), checks: finalChecks,
    metrics: {
      ...state.metrics, ...score, ...availability(frames, score),
      firstAttackAtMs: evidence.firstAttackAtMs,
      firstDetectionLatencyMs: latency(evidence.firstAttackAtMs, evidence.firstDetectionAtMs),
      safetyActivationLatencyMs: latency(evidence.firstAttackAtMs, evidence.firstSafetyActivationAtMs),
      retainedFrames: frames.length, completedFrames, evictedFrames,
      pendingFrames: state.metrics.received - completedFrames,
      scoredWindow: 'retained frames', finalStatus: state.status, safetyState: state.safety.state,
    },
    baseline,
    notes: [
      'Confusion matrices use exactly the same retained frames; only BLOCK is a positive detection. Queue DROP is availability loss, never automatic attack detection. Operational counters are cumulative.',
      'First-detection latency uses the first attack BLOCK decision time (arrival plus modeled queue/rule latency) minus first labelled attack arrival. Safety latency uses the independent modeled activation time. Onsets are preserved throughout the run; these are not hardware measurements.',
      ...(evictedFrames > 0 ? [`Retention limit: ${frames.length} of ${completedFrames} completed frames retained; confusion matrices cover this retained window only. First-onset latency observations were preserved before eviction.`] : []),
      ...(state.metrics.received > completedFrames ? [`${state.metrics.received - completedFrames} received frames remain pending and are excluded from completed-frame evaluation.`] : []),
      ...notes,
    ],
  };
}

function failure(name, profile, attack, error) {
  const empty = scoreFrames([]);
  return {
    name, profile, attack, passed: false,
    checks: [check('Scenario executed without error', false, error instanceof Error ? error.message : String(error))],
    metrics: { ...empty, ...availability([], empty), received: 0, retainedFrames: 0, firstAttackAtMs: null, firstDetectionLatencyMs: null, safetyActivationLatencyMs: null, scoredWindow: 'retained frames' },
    baseline: { ...empty }, notes: ['Execution failed; zero counts do not represent a completed measurement.'],
  };
}

function decisions(frames) {
  // Host wall-clock processing times cannot be part of a deterministic comparison.
  return frames.map(frame => ({
    timestampMs: frame.timestampMs, id: frame.id, data: frame.data,
    decision: frame.decision, reasons: frame.reasons, risk: frame.risk,
    anomalyScore: frame.anomalyScore,
  }));
}

export function runValidation({ seed = 42, durationMs = 6000 } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Validation seed must be an integer from 0 to 4294967295.');
  if (!Number.isInteger(durationMs) || durationMs < 3000 || durationMs > 15000) throw new RangeError('Validation durationMs must be an integer from 3000 to 15000.');
  const cases = [];
  const attackMs = Math.max(2000, Math.floor(durationMs / 3));
  const warmupMs = Math.floor((durationMs - attackMs) / 2);
  const settleMs = durationMs - warmupMs - attackMs;
  function capture(name, profile, attack, run) {
    try { cases.push(run()); }
    catch (error) { cases.push(failure(name, profile, attack, error)); }
  }
  function attacked(type, analyst = true) {
    const sim = new Simulation({ seed, profile: 'urban' });
    sim.setAnalyst(analyst);
    advance(sim, warmupMs);
    // Keep the overload/fast-drift benchmark workloads explicit after calibrating
    // the five user-selectable levels. Low intensity is tested separately.
    const intensity = ['flooding', 'stealth'].includes(type) ? 4 : 2;
    sim.injectAttack({ type, targetId: 0x120, durationMs: attackMs, intensity });
    advance(sim, attackMs);
    sim.clearAttacks();
    advance(sim, settleMs);
    return sim;
  }

  for (const profile of ['urban', 'highway']) {
    const name = `Clean ${profile} traffic`;
    capture(name, profile, null, () => {
      const sim = new Simulation({ seed, profile });
      advance(sim, durationMs);
      const state = sim.snapshot(), score = scoreFrames(sim.getFrames());
      return result(name, profile, null, sim, [
        check('Traffic generated', score.tn + score.fp > 0, `${score.tn + score.fp} normal frames.`),
        check('No attack contamination', score.tp + score.fn === 0, `${score.tp + score.fn} attack frames.`),
        check('False-positive rate at most 1%', score.falsePositiveRate !== null && score.falsePositiveRate <= 0.01, percent(score.falsePositiveRate)),
        check('Normal safety state', state.safety.state === 'NORMAL', state.safety.state),
      ], [profile === 'highway' ? 'Separate synthetic highway holdout: training and validation use the highway profile with different random streams and phases. This is not training-domain transfer or real cross-dataset validation.' : 'Synthetic clean validation traffic is generated independently of model training samples.']);
    });
  }

  for (const type of ATTACKS) {
    const name = `${type[0].toUpperCase()}${type.slice(1)} attack`;
    capture(name, 'urban', type, () => {
      const sim = attacked(type), score = scoreFrames(sim.getFrames());
      const inspected = availability(sim.getFrames(), score);
      return result(name, 'urban', type, sim, [
        check('Attack frames generated', score.tp + score.fn > 0, `${score.tp + score.fn} labelled attack frames.`),
        check('Attack frames rejected', score.tp > 0, `${score.tp} rejected attack frames.`),
        type === 'flooding'
          ? check('Inspected-attack recall at least 80%', inspected.inspectedAttackRecall !== null && inspected.inspectedAttackRecall >= 0.8, `${percent(inspected.inspectedAttackRecall)} among ${inspected.inspectedAttackFrames} inspected attacks; overall recall ${percent(score.recall)}; ${inspected.attackDropped} attack frames dropped before inspection.`)
          : check('Attack recall at least 80%', score.recall !== null && score.recall >= 0.8, percent(score.recall)),
        check('Normal traffic also evaluated', score.tn + score.fp > 0, `${score.tn + score.fp} labelled normal frames.`),
      ], [
        'ID-whitelist baseline rejects unknown identifiers only; known-ID attacks expose its limitations.',
        `Attack exposure: ${attackMs} ms after ${warmupMs} ms clean warmup; ${settleMs} ms settling time.`,
        `Configured intensity: ${['flooding', 'stealth'].includes(type) ? '4 (Severe)' : '2 (Moderate)'}. This benchmark does not establish performance at every intensity.`,
        ...(type === 'flooding' ? ['Flooding deliberately exceeds ingress capacity. Its acceptance check covers filtering of inspected attacks; overall recall includes attack drops as false negatives and is reported separately.'] : []),
      ]);
    });
  }

  capture('Analyst disconnected', 'urban', 'payload', () => {
    const sim = attacked('payload', false), state = sim.snapshot(), score = scoreFrames(sim.getFrames());
    return result('Analyst disconnected', 'urban', 'payload', sim, [
      check('Analyst remains disconnected', !state.analyst.connected, `Connected: ${state.analyst.connected}`),
      check('Gateway protection remains active', score.tp > 0 && score.recall >= 0.8, `${score.tp} rejected; recall ${percent(score.recall)}.`),
      check('Normal traffic can still pass', score.tn > 0, `${score.tn} forwarded normal frames.`),
    ], ['Gateway-local rules are evaluated with the analyst link disconnected.']);
  });

  capture('Safety latch and explicit recovery', 'urban', 'payload', () => {
    const sim = new Simulation({ seed, profile: 'urban' });
    advance(sim, warmupMs);
    sim.injectAttack({ type: 'payload', targetId: 0x120, durationMs: 1000, intensity: 5 });
    advance(sim, 750);
    const during = sim.snapshot();
    let earlyRejected = false;
    try { sim.requestRecovery(); earlyRejected = sim.snapshot().safety.state !== 'NORMAL'; }
    catch (error) { earlyRejected = /quiet|active|attack|recover|eligible|safe/i.test(error.message); }
    sim.clearAttacks();
    advance(sim, 5000);
    const quiet = sim.snapshot();
    sim.requestRecovery();
    advance(sim, 100);
    const recovered = sim.snapshot();
    return result('Safety latch and explicit recovery', 'urban', 'payload', sim, [
      check('Independent safety task activates degradation', during.safety.state === 'DEGRADED', during.safety.state),
      check('Recovery rejected during active attack', earlyRejected, `Safety state during attack: ${during.safety.state}.`),
      check('Safety remains latched after quiet traffic', quiet.safety.state === 'DEGRADED', quiet.safety.state),
      check('Quiet interval enables recovery', quiet.safety.recoveryEligible, `Eligible: ${quiet.safety.recoveryEligible}`),
      check('Explicit recovery restores normal safety', recovered.safety.state === 'NORMAL', recovered.safety.state),
    ], ['Recovery is operator requested after a quiet interval; elapsed quiet time alone must not reset the safety latch.']);
  });

  capture('Deterministic seeded replay', 'urban', 'spoofing', () => {
    const first = attacked('spoofing'), second = attacked('spoofing');
    const left = first.getFrames(), right = second.getFrames();
    return result('Deterministic seeded replay', 'urban', 'spoofing', first, [
      check('Replay population is nonempty', left.length > 0 && right.length > 0, `${left.length} and ${right.length} frames.`),
      check('Same seed produces same traffic and decisions', JSON.stringify(decisions(left)) === JSON.stringify(decisions(right)), `${left.length} and ${right.length} frames; host timing excluded.`),
      check('Same seed produces same classification counts', JSON.stringify(scoreFrames(left)) === JSON.stringify(scoreFrames(right)), 'Confusion matrices compared in full.'),
    ]);
  });

  capture('Evaluator label isolation', 'urban', null, () => {
    const source = attacked('payload');
    const frames = source.getFrames().slice(0, 2000);
    const labelled = new Simulation({ seed, profile: 'urban' });
    const relabelled = new Simulation({ seed, profile: 'urban' });
    for (const frame of frames) {
      const input = { timestampMs: frame.timestampMs, id: frame.id, data: [...frame.data], dlc: frame.data.length };
      labelled.ingest({ ...input, label: frame.label === 'attack' ? 'attack' : 'normal' });
      relabelled.ingest({ ...input, label: frame.label === 'attack' ? 'normal' : 'attack' });
    }
    advance(labelled, 500);
    advance(relabelled, 500);
    return result('Evaluator label isolation', 'urban', null, labelled, [
      check('Both normal and attack ground truth exercised', frames.some(frame => frame.label === 'normal') && frames.some(frame => frame.label === 'attack'), `${frames.length} source frames.`),
      check('Ground truth cannot influence detector decisions', JSON.stringify(decisions(labelled.getFrames())) === JSON.stringify(decisions(relabelled.getFrames())), `${frames.length} identical frames replayed with inverted labels.`),
    ], ['Classification statistics may change when labels change; traffic decisions must stay identical.']);
  });

  return {
    createdAt: new Date().toISOString(), seed, durationMs, datasetKind: 'synthetic',
    summary: { passed: cases.filter(item => item.passed).length, total: cases.length },
    cases,
    limitations: [
      'All validation traffic and model training data are synthetic. No public attack dataset or physical vehicle trace was used.',
      'Urban/highway cases are separate synthetic profile holdouts with profile-specific training, not real cross-dataset or training-domain transfer evaluation.',
      'Modeled bus latency and safety response do not establish hardware timing, electrical behavior, certification, or vehicle safety.',
      'Host processing times are measured on this computer; seeded reproducibility excludes host timing and report creation time.',
      'The ID-whitelist baseline and Sentinel are scored over the same retained labelled frames. Only BLOCK is a positive detection. Queue DROP counts as FN for attacks or TN for normal traffic; availability loss is reported separately by the dropped counter.',
      'Null precision, recall or false-positive rate means its denominator is zero; it does not mean perfect performance.',
    ],
  };
}
