
/** A software CAN laboratory. All timing except processing*Us is modeled. */
export const SIGNALS = Object.freeze([
  { id: 0x120, name: 'Brake', periodMs: 20, criticality: 'critical' },
  { id: 0x130, name: 'Steering', periodMs: 20, criticality: 'critical' },
  { id: 0x200, name: 'Powertrain', periodMs: 20, criticality: 'critical' },
  { id: 0x300, name: 'Battery', periodMs: 100, criticality: 'high' },
  { id: 0x400, name: 'Body', periodMs: 100, criticality: 'low' },
  { id: 0x500, name: 'Infotainment', periodMs: 200, criticality: 'low' },
].map(Object.freeze));

export const INTENSITY_PROFILES = Object.freeze([
  { level: 1, label: 'Low', floodFramesPerSecond: 100, frameIntervalMs: 500, payloadPercent: 10, driftRampMs: 5000 },
  { level: 2, label: 'Moderate', floodFramesPerSecond: 1000, frameIntervalMs: 12, payloadPercent: 25, driftRampMs: 2000 },
  { level: 3, label: 'High', floodFramesPerSecond: 3000, frameIntervalMs: 6, payloadPercent: 50, driftRampMs: 1000 },
  { level: 4, label: 'Severe', floodFramesPerSecond: 6000, frameIntervalMs: 4, payloadPercent: 75, driftRampMs: 450 },
  { level: 5, label: 'Maximum', floodFramesPerSecond: 15000, frameIntervalMs: 3, payloadPercent: 100, driftRampMs: 180 },
].map(Object.freeze));

export function describeAttackIntensity(type, intensity) {
  const p = INTENSITY_PROFILES.find(profile => profile.level === intensity);
  if (!p) throw new RangeError('intensity must be an integer from 1 to 5');
  const descriptions = {
    flooding: `${p.floodFramesPerSecond.toLocaleString('en-US')} extra frames/s offered to CAN A`,
    spoofing: `One forged frame every ${p.frameIntervalMs} ms`,
    replay: `One captured frame replayed every ${p.frameIntervalMs} ms`,
    fuzzing: `One malformed or unknown-ID frame every ${p.frameIntervalMs} ms`,
    payload: `${p.payloadPercent}% of target frames carry an out-of-range command`,
    stealth: `Payload drifts to its target over ${p.driftRampMs} ms`,
  };
  if (!Object.hasOwn(descriptions, type)) throw new RangeError('Unknown attack type');
  return { level: p.level, label: p.label, description: descriptions[type] };
}

export const SCENARIOS = Object.freeze([
  { id: 'spoofing', name: 'ECU spoofing', description: 'A second source impersonates an allowed ECU with invalid timing and counters.' },
  { id: 'replay', name: 'Captured frame replay', description: 'Repeatedly reintroduce a captured payload and rolling counter.' },
  { id: 'flooding', name: 'CAN bus flooding', description: 'Increase offered CAN traffic from light pressure to bus-capacity overload.' },
  { id: 'fuzzing', name: 'Protocol fuzzing', description: 'Unknown standard identifiers and malformed schema lengths.' },
  { id: 'payload', name: 'Payload manipulation', description: 'Replace an ECU value with an implausible command while retaining valid timing.' },
  { id: 'stealth', name: 'Gradual payload drift', description: 'Slowly alter valid, correctly timed payloads to test the separately trained analyst.' },
].map(Object.freeze));

const BY_ID = new Map(SIGNALS.map(signal => [signal.id, signal]));
const LIMITS = Object.freeze({ frameCapacity: 20000, eventCapacity: 256, seriesCapacity: 600 });
const QUEUE_CAPACITY = 128;
const ANALYST_CAPACITY = 256;
const BUS_BITS_PER_MS = 500;
const QUIET_MS = 2500;
const ACK_MS = 60;
const SPRT = Object.freeze({ p0: 0.01, p1: 0.65, alpha: 0.001, beta: 0.01 });
const RULES = Object.freeze([
  { key: 'whitelist', name: 'Identifier allowlist', enabled: true, description: 'Only the six configured standard CAN identifiers may cross the gateway.' },
  { key: 'dlc', name: 'Schema length', enabled: true, description: 'Configured signals require eight bytes; classical CAN accepts at most eight.' },
  { key: 'timing', name: 'Minimum inter-arrival time', enabled: true, description: 'Reject frames arriving sooner than 45% of the configured period; tolerate modeled arbitration jitter.' },
  { key: 'plausibility', name: 'Physical range and slew', enabled: true, description: 'Check decoded values, reserved fields, and changes against the last accepted signal.' },
  { key: 'replay', name: 'Rolling counter freshness', enabled: true, description: 'An eight-bit counter must advance within a time-dependent bounded window. Baselines expire after two seconds without accepted traffic. This is not authentication.' },
  { key: 'flood', name: 'Rate and queue protection', enabled: true, description: 'Bound both bus queues and inspect 100 ms per-identifier traffic windows.' },
]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const hex = id => `0x${id.toString(16).toUpperCase().padStart(3, '0')}`;
const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const round = (value, digits = 2) => Number(value.toFixed(digits));

class Ring {
  constructor(capacity) { this.capacity = capacity; this.items = new Array(capacity); this.length = 0; this.next = 0; }
  push(item) { this.items[this.next] = item; this.next = (this.next + 1) % this.capacity; this.length = Math.min(this.capacity, this.length + 1); }
  values() { return Array.from({ length: this.length }, (_, index) => this.items[(this.next - this.length + index + this.capacity) % this.capacity]); }
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function validateOptions(seed, profile) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) throw new RangeError('seed must be an integer from 0 to 4294967295');
  if (!['urban', 'highway'].includes(profile)) throw new RangeError('profile must be urban or highway');
}

function normalValues(signal, profile, timeMs, random) {
  const seconds = timeMs / 1000;
  const noise = (random() - 0.5) * 0.3;
  const speed = profile === 'urban'
    ? 38 + 16 * Math.sin(seconds / 7) + 4 * Math.sin(seconds / 2)
    : 99 + 9 * Math.sin(seconds / 11) + 2 * Math.sin(seconds / 3);
  switch (signal.id) {
    case 0x120: return [Math.max(0, -Math.cos(seconds / 7)) * (profile === 'urban' ? 27 : 12) + Math.max(0, noise), speed];
    case 0x130: return [(profile === 'urban' ? 11 : 4) * Math.sin(seconds / 3) + noise, speed];
    case 0x200: return [speed + noise, 780 + speed * 29 + noise * 10];
    case 0x300: return [79 + 1.8 * Math.sin(seconds / 15) + noise / 8, 31 + 2 * Math.sin(seconds / 9)];
    case 0x400: return [Math.floor(seconds / 8) % 2, 12.6 + noise / 10];
    case 0x500: return [28 + 7 * Math.sin(seconds / 13) + noise, 1];
    default: return [0, 0];
  }
}

function encode(id, primary, auxiliary, counter) {
  const data = new Array(8).fill(0);
  const raw = clamp(Math.round((id === 0x130 ? primary + 180 : primary) * 100), 0, 65535);
  const aux = clamp(Math.round(auxiliary * (id === 0x200 ? 1 : 100)), 0, 65535);
  data[0] = raw & 255; data[1] = raw >>> 8;
  data[2] = aux & 255; data[3] = aux >>> 8;
  data[7] = counter & 255;
  return data;
}

function decode(id, data) {
  return [(data[0] + data[1] * 256) / 100 - (id === 0x130 ? 180 : 0),
    (data[2] + data[3] * 256) / (id === 0x200 ? 1 : 100)];
}

function fitModel(profile, seed) {
  const random = seeded((seed ^ 0xC0FFEE91) >>> 0);
  const models = new Map();
  let samples = 0;
  // A separate two-minute clean trace, offset in phase, is never reused for evaluation.
  for (const signal of SIGNALS) {
    let count = 0;
    const mean = [0, 0]; const m2 = [0, 0];
    for (let timeMs = 0; timeMs < 120000; timeMs += signal.periodMs) {
      const values = normalValues(signal, profile, timeMs + 17391, random);
      count++;
      values.forEach((value, dimension) => {
        const difference = value - mean[dimension];
        mean[dimension] += difference / count;
        m2[dimension] += difference * (value - mean[dimension]);
      });
    }
    models.set(signal.id, { mean, deviation: m2.map(value => Math.max(0.15, Math.sqrt(value / (count - 1)))), samples: count });
    samples += count;
  }
  return { models, samples };
}

function frameBits(dlc) {
  // Conservative classical-CAN estimate including intermission and worst-case stuffing.
  return 47 + dlc * 8 + Math.ceil((34 + dlc * 8) / 4) + 3;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.ceil(sorted.length * fraction) - 1], 3);
}

function validateFrame(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new TypeError('frame must be an object');
  if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs > Number.MAX_SAFE_INTEGER - 10000) throw new RangeError('timestampMs must be a finite non-negative safe timestamp');
  if (!Number.isInteger(frame.id) || frame.id < 0 || frame.id > 0x7FF) throw new RangeError('id must be an 11-bit standard CAN identifier');
  if (!Array.isArray(frame.data) || frame.data.length > 8 || frame.data.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new RangeError('data must contain zero to eight integer bytes');
  if (frame.dlc !== undefined && frame.dlc !== frame.data.length) throw new RangeError('dlc must equal the number of data bytes');
  if (frame.label !== undefined && !['normal', 'attack', 'unknown'].includes(frame.label)) throw new RangeError('label must be normal, attack, or unknown');
  if (frame.attackType !== undefined && (typeof frame.attackType !== 'string' || frame.attackType.length > 80)) throw new RangeError('attackType must be a string of at most 80 characters');
}

export class Simulation {
  constructor({ seed = 42, profile = 'urban' } = {}) { this.reset({ seed, profile }); }

  reset({ seed = this.seed ?? 42, profile = this.profile ?? 'urban' } = {}) {
    validateOptions(seed, profile);
    this.seed = seed; this.profile = profile; this.running = false; this.speed = 1; this.timeMs = 0;
    this.risk = 0; this.status = 'OBSERVE'; this.random = seeded(seed);
    this.analystConnected = true; this.model = fitModel(profile, seed);
    this.analystTelemetry = { processed: 0, outliers: 0, lastObservation: null };
    this.safety = { state: 'NORMAL', reason: 'No safety request', requestedAtMs: null, activatedAtMs: null, recoveryEligible: false };
    this.vehicle = { speedKph: 0, rpm: 0, brakePct: 0, steeringDeg: 0, batteryPct: 79, motorEnabled: true };
    this.metrics = { received: 0, forwarded: 0, blocked: 0, dropped: 0, alerts: 0, busLoadPct: 0, queueDepth: 0, processingP50Us: 0, processingP95Us: 0, simulatedLatencyP95Us: 0, tp: 0, fp: 0, tn: 0, fn: 0, precision: null, recall: null, falsePositiveRate: null };
    this.frames = new Ring(LIMITS.frameCapacity); this.recentFrames = []; this.events = new Ring(LIMITS.eventCapacity); this.series = new Ring(LIMITS.seriesCapacity);
    this.hostTimes = new Ring(512); this.latencies = new Ring(2048);
    this.busA = { queue: [], current: null }; this.busB = { queue: [], current: null };
    this.sources = new Map(SIGNALS.map((signal, index) => [signal.id, { due: index, counter: 0, last: null }]));
    this.histories = new Map(); this.rateWindows = new Map(); this.quarantine = new Map(); this.analystPending = [];
    this.analystStreaks = new Map(); this.attacks = []; this.sequence = 0; this.eventSequence = 0;
    this.lastEvidenceMs = -Infinity; this.lastCriticalMs = -Infinity; this.lastImportedMs = -Infinity; this.mode = 'synthetic';
    this.alertTimes = new Map(); this.binEvidence = false; this.binWeight = 0; this.nextEvidenceMs = 100;
    this.sprt = { value: 0, upperThreshold: Math.log((1 - SPRT.beta) / SPRT.alpha), lowerThreshold: Math.log(SPRT.beta / (1 - SPRT.alpha)) };
    this.sprtConfirmedUntil = -Infinity; this.sprtDecisions = { normal: 0, attack: 0 };
    this.bucket = { received: 0, forwarded: 0, blocked: 0, bitsA: 0, bitsB: 0 }; this.nextSeriesMs = 1000;
    this.busLoadWindow = []; this.windowBits = 0;
    this._event('info', 'Laboratory ready', `Seed ${seed}; ${profile} profile; both CAN segments modeled at 500 kbit/s.`);
    return this.snapshot();
  }

  setRunning(value) { if (typeof value !== 'boolean') throw new TypeError('running must be a boolean'); this.running = value; }
  setSpeed(value) { if (![0.5, 1, 2, 5, 10].includes(value)) throw new RangeError('speed must be 0.5, 1, 2, 5, or 10'); this.speed = value; }
  setAnalyst(value) {
    if (typeof value !== 'boolean') throw new TypeError('connected must be a boolean');
    if (value === this.analystConnected) return;
    this.analystConnected = value;
    this.analystPending = []; this.analystStreaks.clear(); this.quarantine.clear();
    this._event(value ? 'info' : 'warning', value ? 'Analyst connected' : 'Analyst disconnected', value ? 'The independently trained statistical model is available.' : 'Gateway rules and independent safety coordination remain active.');
  }

  injectAttack({ type, targetId = 0x120, durationMs = 5000, intensity = 2 } = {}) {
    if (!SCENARIOS.some(scenario => scenario.id === type)) throw new RangeError('Unknown attack type');
    if (!Number.isInteger(targetId) || targetId < 0 || targetId > 0x7FF) throw new RangeError('targetId must be an 11-bit CAN identifier');
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 60000) throw new RangeError('durationMs must be an integer from 100 to 60000');
    if (!Number.isInteger(intensity) || intensity < 1 || intensity > 5) throw new RangeError('intensity must be an integer from 1 to 5');
    if (this.mode === 'trace') throw new RangeError('Reset the laboratory before injecting synthetic attacks into a trace session');
    if (this.attacks.length >= 8) throw new RangeError('At most eight attacks may be active');
    if (['payload', 'stealth'].includes(type) && !BY_ID.has(targetId)) throw new RangeError('Payload attacks require a configured signal identifier');
    const source = this.sources.get(targetId);
    this.attacks.push({ type, targetId, intensity, payloadBudget: 0, startsAtMs: this.timeMs, endsAtMs: this.timeMs + durationMs, due: this.timeMs, captured: source?.last?.slice() ?? encode(targetId, 0, 0, 0) });
    const strength = describeAttackIntensity(type, intensity);
    this._event('info', 'Scenario started', `${SCENARIOS.find(scenario => scenario.id === type).name} targeting ${hex(targetId)} for ${durationMs} ms. Intensity ${intensity}/5 (${strength.label}): ${strength.description}. Scenario labels are used only for evaluation.`);
  }

  clearAttacks() { const count = this.attacks.length; this.attacks = []; if (count) this._event('info', 'Attack sources stopped', 'Queued frames and pending analyst evidence are still processed.'); }

  requestRecovery() {
    this._updateSafety(this.timeMs);
    if (this.safety.state !== 'DEGRADED') throw new RangeError('Recovery requires an acknowledged degraded state');
    if (!this.safety.recoveryEligible) throw new RangeError('Recovery requires cleared attacks, drained queues, and 2500 ms without suspicious evidence');
    this.safety = { state: 'NORMAL', reason: 'Explicit recovery after a quiet interval', requestedAtMs: null, activatedAtMs: null, recoveryEligible: false };
    this.vehicle.motorEnabled = true; this.risk = 0; this.sprt.value = 0; this.sprtConfirmedUntil = -Infinity; this.status = 'OBSERVE';
    this.quarantine.clear(); this.analystStreaks.clear(); this.histories.clear();
    this._event('info', 'Normal operation restored', 'The independent safety task accepted an explicit recovery request.');
    return true;
  }

  advance(milliseconds) {
    if (!Number.isInteger(milliseconds) || milliseconds < 1 || milliseconds > 10000) throw new RangeError('milliseconds must be an integer from 1 to 10000');
    this._advanceTo(this.timeMs + milliseconds, this.mode === 'synthetic');
  }

  ingest(frame) {
    validateFrame(frame);
    if (frame.timestampMs < this.lastImportedMs) throw new RangeError('Imported timestamps must be monotonic');
    if (this.mode === 'synthetic' && (this.metrics.received || this.timeMs || this.attacks.length)) throw new RangeError('Import traces into a fresh simulation');
    if (frame.timestampMs < this.timeMs) throw new RangeError('Imported timestamp precedes the advanced simulation clock');
    this.mode = 'trace'; this.running = false;
    this._advanceTo(frame.timestampMs, false);
    this.lastImportedMs = frame.timestampMs;
    this._enqueue({ timestampMs: frame.timestampMs, id: frame.id, dlc: frame.data.length, data: frame.data.slice(), label: frame.label ?? 'unknown', attackType: frame.attackType });
  }

  _advanceTo(target, generate) {
    while (this.timeMs < target) {
      if (!generate && target - this.timeMs > 1000 && !this._queueDepth() && !this.analystPending.length && this.risk === 0 && !this.binEvidence && this.safety.state !== 'REQUESTED') { this._skipIdle(target); break; }
      const start = this.timeMs;
      const end = Math.min(target, start + 1);
      if (generate) { this._generateNormal(start); this._generateAttacks(start); }
      this._processAnalyst(start);
      const bitsA = this._service(this.busA, start, end, 'A');
      const bitsB = this._service(this.busB, start, end, 'B');
      this.timeMs = end;
      this.bucket.bitsA += bitsA; this.bucket.bitsB += bitsB;
      this.busLoadWindow.push({ at: end, bits: bitsA }); this.windowBits += bitsA;
      while (this.busLoadWindow.length && this.busLoadWindow[0].at <= end - 1000) this.windowBits -= this.busLoadWindow.shift().bits;
      this.metrics.busLoadPct = clamp(this.windowBits / (BUS_BITS_PER_MS * Math.min(1000, Math.max(1, end))) * 100, 0, 100);
      this._processAnalyst(end);
      while (this.nextEvidenceMs <= end) { this._updateEvidence(this.nextEvidenceMs); this.nextEvidenceMs += 100; }
      this._updateSafety(end);
      while (this.nextSeriesMs <= end) { this._pushSeries(this.nextSeriesMs); this.nextSeriesMs += 1000; }
      this.attacks = this.attacks.filter(attack => attack.endsAtMs > end);
    }
  }

  _skipIdle(target) {
    let bins = Math.max(0, Math.floor((target - this.nextEvidenceMs) / 100) + 1);
    // Finish the current sequential trial, then skip complete identical clean trials.
    while (bins && this.sprt.value !== 0) { this._updateEvidence(this.nextEvidenceMs); this.nextEvidenceMs += 100; bins--; }
    const cleanTrialBins = Math.ceil(this.sprt.lowerThreshold / Math.log((1 - SPRT.p1) / (1 - SPRT.p0)));
    const wholeTrials = Math.floor(bins / cleanTrialBins);
    this.sprtDecisions.normal += wholeTrials;
    this.nextEvidenceMs += wholeTrials * cleanTrialBins * 100;
    bins -= wholeTrials * cleanTrialBins;
    while (bins--) { this._updateEvidence(this.nextEvidenceMs); this.nextEvidenceMs += 100; }
    this.busLoadWindow = []; this.windowBits = 0; this.metrics.busLoadPct = 0;
    const last = Math.floor(target / 1000) * 1000;
    if (this.nextSeriesMs <= last) {
      this._pushSeries(this.nextSeriesMs);
      for (let time = Math.max(this.nextSeriesMs + 1000, last - (LIMITS.seriesCapacity - 1) * 1000); time <= last; time += 1000) this._pushSeries(time);
      this.nextSeriesMs = last + 1000;
    }
    this.timeMs = target; this._updateSafety(target); this._setStatus();
  }

  _generateNormal(timeMs) {
    for (const signal of SIGNALS) {
      const source = this.sources.get(signal.id);
      if (source.due > timeMs) continue;
      source.due += signal.periodMs;
      const values = normalValues(signal, this.profile, timeMs, this.random);
      if (this.safety.state === 'DEGRADED' && signal.id === 0x200) {
        const multiplier = Math.exp(-(timeMs - this.safety.activatedAtMs) / 1800);
        values[0] *= multiplier; values[1] = values[0] * 29;
      }
      let data = encode(signal.id, ...values, source.counter++);
      source.last = data.slice();
      let label = 'normal'; let attackType;
      const replacement = this.attacks.find(attack => attack.targetId === signal.id && ['payload', 'stealth'].includes(attack.type) && timeMs < attack.endsAtMs);
      const profile = replacement && INTENSITY_PROFILES[replacement.intensity - 1];
      if (replacement?.type === 'payload') replacement.payloadBudget += profile.payloadPercent;
      if (replacement && (replacement.type === 'stealth' || replacement.payloadBudget >= 100)) {
        label = 'attack'; attackType = replacement.type;
        if (replacement.type === 'payload') {
          replacement.payloadBudget -= 100;
          data = encode(signal.id, signal.id === 0x130 ? 300 : 450, values[1], data[7]);
        }
        else {
          const fraction = clamp((timeMs - replacement.startsAtMs) / profile.driftRampMs, 0, 1);
          const target = { 288: 90, 304: 75, 512: 195, 768: 98, 1024: 13, 1280: 98 }[signal.id];
          data = encode(signal.id, values[0] + (target - values[0]) * fraction, values[1], data[7]);
        }
      }
      this._enqueue({ timestampMs: timeMs, id: signal.id, dlc: 8, data, label, attackType });
    }
  }

  _generateAttacks(timeMs) {
    for (const attack of this.attacks) {
      if (timeMs >= attack.endsAtMs || timeMs < attack.due || ['payload', 'stealth'].includes(attack.type)) continue;
      const profile = INTENSITY_PROFILES[attack.intensity - 1];
      const count = attack.type === 'flooding' ? Math.max(1, profile.floodFramesPerSecond / 1000) : 1;
      attack.due = timeMs + (attack.type === 'flooding' ? Math.max(1, 1000 / profile.floodFramesPerSecond) : profile.frameIntervalMs);
      for (let index = 0; index < count; index++) {
        let id = attack.targetId;
        let data = attack.captured.slice();
        if (attack.type === 'spoofing') { data = this.sources.get(id)?.last?.slice() ?? data; data[7] = (data[7] + 128) & 255; }
        if (attack.type === 'fuzzing') {
          id = 0x600 + Math.floor(this.random() * 0x100);
          data = Array.from({ length: Math.floor(this.random() * 9) }, () => Math.floor(this.random() * 256));
        }
        this._enqueue({ timestampMs: timeMs, id, dlc: data.length, data, label: 'attack', attackType: attack.type });
      }
    }
  }

  _enqueue(frame) {
    this.metrics.received = increment(this.metrics.received); this.bucket.received++;
    frame.seq = ++this.sequence;
    if (this.busA.queue.length + Number(Boolean(this.busA.current)) >= QUEUE_CAPACITY) {
      this._evidence(frame.id, 5, frame.timestampMs, 'Ingress queue saturated');
      this._record(frame, 'DROP', ['Ingress queue capacity exceeded'], 0, 0);
      return;
    }
    this.busA.queue.push({ frame, readyAt: frame.timestampMs, remaining: frameBits(frame.dlc) });
  }

  _service(bus, start, end, segment) {
    let cursor = start; let spent = 0;
    while (cursor < end - 1e-9) {
      if (!bus.current) {
        let choice = -1;
        for (let index = 0; index < bus.queue.length; index++) {
          const entry = bus.queue[index];
          if (entry.readyAt <= cursor + 1e-9 && (choice < 0 || entry.frame.id < bus.queue[choice].frame.id || (entry.frame.id === bus.queue[choice].frame.id && entry.frame.seq < bus.queue[choice].frame.seq))) choice = index;
        }
        if (choice < 0) {
          if (!bus.queue.length) break;
          cursor = Math.max(cursor, Math.min(...bus.queue.map(entry => entry.readyAt)));
          if (cursor >= end - 1e-9) break;
          continue;
        }
        bus.current = bus.queue.splice(choice, 1)[0];
      }
      const bits = Math.min(bus.current.remaining, (end - cursor) * BUS_BITS_PER_MS);
      bus.current.remaining -= bits; cursor += bits / BUS_BITS_PER_MS; spent += bits;
      if (bus.current.remaining <= 1e-8) {
        const entry = bus.current; bus.current = null;
        if (segment === 'A') this._inspect(entry.frame, cursor);
        else {
          this._record(entry.frame, 'FORWARD', entry.reasons, entry.score, (cursor - entry.frame.timestampMs) * 1000);
          this._receiveVehicle(entry.frame);
        }
      }
    }
    return spent;
  }

  _inspect(frame, timestampMs) {
    const measuredStart = performance.now();
    const signal = BY_ID.get(frame.id); const reasons = [];
    let values; let score = 0; let abnormal = false;
    if (!signal) reasons.push('Identifier is not on the gateway allowlist');
    else {
      if (frame.dlc !== 8) reasons.push('Signal schema requires DLC 8');
      const history = this.histories.get(frame.id);
      const arrivals = this.rateWindows.get(frame.id) ?? [];
      while (arrivals.length && arrivals[0] <= timestampMs - 100) arrivals.shift();
      if (arrivals.length < 128) arrivals.push(timestampMs);
      this.rateWindows.set(frame.id, arrivals);
      if (arrivals.length > Math.ceil(100 / signal.periodMs) * 2 + 2) reasons.push('Per-identifier rate exceeds the 100 ms budget');
      if (history && timestampMs - history.at < signal.periodMs * 0.45) reasons.push('Inter-arrival time is shorter than the configured period');
      if (frame.dlc === 8) {
        values = decode(frame.id, frame.data);
        if (!this._plausible(frame.id, values, frame.data)) reasons.push('Payload violates physical bounds or reserved fields');
        if (history) {
          const delta = (frame.data[7] - history.counter + 256) & 255;
          const maximum = Math.min(127, Math.max(3, Math.ceil((timestampMs - history.at) / signal.periodMs) + 2));
          // An eight-bit unauthenticated counter becomes ambiguous after a long outage.
          // Expire the baseline instead of permanently locking out a recovered ECU.
          const baselineExpired = timestampMs - history.at > Math.min(2000, signal.periodMs * 128);
          if (!baselineExpired && (delta === 0 || delta > maximum)) reasons.push('Rolling counter is stale or outside the freshness window');
          const allowedChange = { 288: 25, 304: 30, 512: 35, 768: 8, 1024: 15, 1280: 40 }[frame.id];
          if (Math.abs(values[0] - history.values[0]) > allowedChange * Math.max(1, (timestampMs - history.at) / signal.periodMs)) reasons.push('Payload changes faster than the configured slew limit');
        }
        if (this.analystConnected) {
          const learned = this.model.models.get(frame.id);
          // Safety-induced speed reductions are an expected operating mode, not an intrusion.
          const dimensions = this.safety.state !== 'NORMAL' && frame.id === 0x200 ? [] : [0, 1];
          const distance = Math.max(0, ...dimensions.map(dimension => Math.abs(values[dimension] - learned.mean[dimension]) / learned.deviation[dimension]));
          score = clamp(distance / 6, 0, 1); abnormal = distance > 4.5;
          if (this.analystPending.length < ANALYST_CAPACITY) this.analystPending.push({ due: timestampMs + 40, id: frame.id, abnormal, score });
        }
      }
      if (this.analystConnected && (this.quarantine.get(frame.id) ?? 0) > timestampMs) reasons.push('Analyst hold: sustained deviation from learned normal traffic');
      if (!reasons.length && values) this.histories.set(frame.id, { at: timestampMs, counter: frame.data[7], values });
    }
    const modeledProcessingMs = 0.018 + reasons.length * 0.004;
    if (reasons.length) {
      this._evidence(frame.id, reasons.some(reason => reason.includes('physical')) ? 13 : 9, timestampMs, reasons[0]);
      this._record(frame, 'BLOCK', reasons, score, (timestampMs - frame.timestampMs + modeledProcessingMs) * 1000);
    } else if (this.busB.queue.length + Number(Boolean(this.busB.current)) >= QUEUE_CAPACITY) {
      this._evidence(frame.id, 5, timestampMs, 'Egress queue saturated');
      this._record(frame, 'DROP', ['Egress queue capacity exceeded'], score, (timestampMs - frame.timestampMs + modeledProcessingMs) * 1000);
    } else {
      this.busB.queue.push({ frame, readyAt: timestampMs + modeledProcessingMs, remaining: frameBits(frame.dlc), score, reasons: ['Gateway checks passed'] });
    }
    this.hostTimes.push((performance.now() - measuredStart) * 1000);
  }

  _plausible(id, [primary, auxiliary], data) {
    if (data[4] || data[5] || data[6]) return false;
    const ranges = { 288: [0, 100, 0, 240], 304: [-90, 90, 0, 240], 512: [0, 240, 0, 9000], 768: [0, 100, -0.01, 80], 1024: [0, 15, 8, 16], 1280: [0, 100, 0, 16] };
    const [low, high, auxLow, auxHigh] = ranges[id];
    return primary >= low && primary <= high && auxiliary >= auxLow && auxiliary <= auxHigh;
  }

  _processAnalyst(timeMs) {
    while (this.analystPending.length && this.analystPending[0].due <= timeMs) {
      const sample = this.analystPending.shift();
      if (!this.analystConnected) continue;
      this.analystTelemetry.processed++;
      if (sample.abnormal) this.analystTelemetry.outliers++;
      this.analystTelemetry.lastObservation = { id: sample.id, atMs: timeMs, score: round(sample.score, 4), abnormal: sample.abnormal };
      const streak = sample.abnormal ? (this.analystStreaks.get(sample.id) ?? 0) + 1 : 0;
      this.analystStreaks.set(sample.id, Math.min(8, streak));
      if (streak >= 3) {
        this.quarantine.set(sample.id, timeMs + 500);
        this._evidence(sample.id, 12, timeMs, 'Learned analyst detected sustained payload deviation');
      }
    }
  }

  _evidence(id, weight, timeMs, reason) {
    const criticality = BY_ID.get(id)?.criticality ?? 'high';
    const multiplier = criticality === 'critical' ? 1 : criticality === 'high' ? 0.7 : 0.4;
    this.binEvidence = true; this.binWeight = Math.max(this.binWeight, weight * multiplier);
    this.lastEvidenceMs = Math.max(this.lastEvidenceMs, timeMs);
    if (criticality === 'critical') this.lastCriticalMs = timeMs;
    this.risk = clamp(this.risk + 0.12 * multiplier, 0, 100);
    this._alert(`${id}:${reason}`, timeMs, `${BY_ID.get(id)?.name ?? hex(id)} traffic rejected`, reason);
  }

  _updateEvidence(timeMs) {
    this.sprt.value += this.binEvidence ? Math.log(SPRT.p1 / SPRT.p0) : Math.log((1 - SPRT.p1) / (1 - SPRT.p0));
    if (this.sprt.value >= this.sprt.upperThreshold) {
      this.sprtConfirmedUntil = timeMs + 1500; this.sprtDecisions.attack++;
      this._alert('sprt', timeMs, 'Sustained threat confirmed', 'The sequential likelihood ratio crossed the configured attack boundary.');
      this.sprt.value = 0;
    } else if (this.sprt.value <= this.sprt.lowerThreshold) { this.sprtDecisions.normal++; this.sprt.value = 0; }
    this.risk = clamp(this.risk + (this.binEvidence ? this.binWeight : -2.5), 0, 100);
    this.binEvidence = false; this.binWeight = 0;
    if (this.safety.state === 'NORMAL' && this.risk >= 65 && this.sprtConfirmedUntil >= timeMs && timeMs - this.lastCriticalMs < 1200) {
      this.safety.state = 'REQUESTED'; this.safety.reason = 'Sustained critical-signal evidence confirmed by SPRT'; this.safety.requestedAtMs = timeMs;
      this._event('critical', 'Degraded operation requested', 'The gateway sent a request to the independent safety task; acknowledgment is pending.', timeMs);
    }
    this._setStatus();
  }

  _updateSafety(timeMs) {
    if (this.safety.state === 'REQUESTED' && timeMs >= this.safety.requestedAtMs + ACK_MS) {
      this.safety.state = 'DEGRADED'; this.safety.activatedAtMs = this.safety.requestedAtMs + ACK_MS; this.vehicle.motorEnabled = false;
      this._event('critical', 'Safety task acknowledged', 'The modeled motor enable is latched off until explicit, eligible recovery.', this.safety.activatedAtMs);
    }
    this.safety.recoveryEligible = this.safety.state === 'DEGRADED' && this.attacks.length === 0 && timeMs - this.lastEvidenceMs >= QUIET_MS && this.busA.queue.length < 4 && this.busB.queue.length < 4;
    this._setStatus();
  }

  _setStatus() { this.status = this.safety.state !== 'NORMAL' ? 'REQUEST_DEGRADE' : this.risk >= 30 ? 'FILTER' : this.risk >= 8 ? 'WARN' : 'OBSERVE'; }
  _queueDepth() { return this.busA.queue.length + this.busB.queue.length + Number(Boolean(this.busA.current)) + Number(Boolean(this.busB.current)); }

  _record(frame, decision, reasons, anomalyScore, latencyUs) {
    const key = decision === 'FORWARD' ? 'forwarded' : decision === 'BLOCK' ? 'blocked' : 'dropped';
    this.metrics[key] = increment(this.metrics[key]);
    if (key !== 'dropped') this.bucket[key]++;
    // Ground truth is read only here, after the detector's decision is final.
    if (frame.label === 'attack') { const metric = decision === 'BLOCK' ? 'tp' : 'fn'; this.metrics[metric] = increment(this.metrics[metric]); }
    if (frame.label === 'normal') { const metric = decision === 'BLOCK' ? 'fp' : 'tn'; this.metrics[metric] = increment(this.metrics[metric]); }
    this.latencies.push(Math.max(0, latencyUs));
    const recorded = { seq: frame.seq, timestampMs: frame.timestampMs, id: frame.id, dlc: frame.dlc, data: frame.data.slice(), signal: BY_ID.get(frame.id)?.name ?? 'Unknown', decision, reasons: [...reasons], risk: round(this.risk), anomalyScore: round(anomalyScore, 4), latencyUs: round(Math.max(0, latencyUs), 3), label: frame.label ?? 'unknown', ...(frame.attackType ? { attackType: frame.attackType } : {}) };
    this.frames.push(recorded);
    if (this.recentFrames.length < 160 || recorded.seq > this.recentFrames[0].seq) {
      let low = 0; let high = this.recentFrames.length;
      while (low < high) { const middle = (low + high) >>> 1; if (this.recentFrames[middle].seq < recorded.seq) low = middle + 1; else high = middle; }
      this.recentFrames.splice(low, 0, recorded);
      if (this.recentFrames.length > 160) this.recentFrames.shift();
    }
  }

  _receiveVehicle(frame) {
    if (frame.dlc !== 8) return;
    const values = decode(frame.id, frame.data);
    if (frame.id === 0x120) this.vehicle.brakePct = round(values[0]);
    if (frame.id === 0x130) this.vehicle.steeringDeg = round(values[0]);
    if (frame.id === 0x200) { this.vehicle.speedKph = round(values[0]); this.vehicle.rpm = round(values[1], 0); }
    if (frame.id === 0x300) this.vehicle.batteryPct = round(values[0]);
  }

  _event(severity, title, detail, timestampMs = this.timeMs) {
    this.events.push({ id: ++this.eventSequence, timestampMs: round(timestampMs, 3), severity, title, detail });
  }
  _alert(key, timeMs, title, detail) {
    if (timeMs - (this.alertTimes.get(key) ?? -Infinity) < 1000) return;
    // Unknown/fuzzed IDs cannot grow the cooldown map without limit.
    if (this.alertTimes.size >= 128 && !this.alertTimes.has(key)) this.alertTimes.delete(this.alertTimes.keys().next().value);
    this.alertTimes.set(key, timeMs); this.metrics.alerts = increment(this.metrics.alerts);
    this._event(this.risk >= 65 ? 'critical' : 'warning', title, detail, timeMs);
  }
  _pushSeries(timeMs) {
    this.series.push({ timeMs, received: this.bucket.received, forwarded: this.bucket.forwarded, blocked: this.bucket.blocked, risk: round(this.risk), busLoadPct: round(clamp(this.bucket.bitsA / (BUS_BITS_PER_MS * 1000) * 100, 0, 100)) });
    this.bucket = { received: 0, forwarded: 0, blocked: 0, bitsA: 0, bitsB: 0 };
  }

  getFrames() { return this.frames.values().sort((a, b) => a.seq - b.seq).map(frame => ({ ...frame, data: [...frame.data], reasons: [...frame.reasons] })); }

  snapshot() {
    const metric = this.metrics;
    const metrics = { ...metric, busLoadPct: round(metric.busLoadPct), queueDepth: this._queueDepth(), processingP50Us: percentile(this.hostTimes.values(), 0.5), processingP95Us: percentile(this.hostTimes.values(), 0.95), simulatedLatencyP95Us: percentile(this.latencies.values(), 0.95), precision: metric.tp + metric.fp ? metric.tp / (metric.tp + metric.fp) : null, recall: metric.tp + metric.fn ? metric.tp / (metric.tp + metric.fn) : null, falsePositiveRate: metric.fp + metric.tn ? metric.fp / (metric.fp + metric.tn) : null };
    return {
      version: '1.0.0', seed: this.seed, profile: this.profile, running: this.running, speed: this.speed, timeMs: round(this.timeMs, 3), status: this.status, risk: round(this.risk),
      analyst: { connected: this.analystConnected, trained: true, trainingSamples: this.model.samples,
        processed: this.analystTelemetry.processed, outliers: this.analystTelemetry.outliers,
        lastObservation: this.analystTelemetry.lastObservation ? { ...this.analystTelemetry.lastObservation } : null,
        activeHolds: [...this.quarantine].filter(([, untilMs]) => untilMs > this.timeMs).map(([id, untilMs]) => ({ id, untilMs })),
        description: 'Per-signal Gaussian payload model fitted on a separate seeded 120-second synthetic clean trace; 3 consecutive outliers, 40 ms modeled side-channel delay.' },
      safety: { ...this.safety, requestCriteria: {
        elevatedRisk: this.risk >= 65,
        sustainedThreat: this.sprtConfirmedUntil >= this.timeMs,
        criticalSignalEvidence: this.timeMs - this.lastCriticalMs < 1200,
      } }, metrics, vehicle: { ...this.vehicle },
      activeAttacks: this.attacks.map(({ type, targetId, intensity, startsAtMs, endsAtMs }) => ({ type, targetId, intensity, strength: describeAttackIntensity(type, intensity), startsAtMs, endsAtMs })),
      frames: this.recentFrames.map(frame => ({ ...frame, data: [...frame.data], reasons: [...frame.reasons] })).reverse(), events: this.events.values().slice(-120).map(event => ({ ...event })).reverse(), series: this.series.values().map(point => ({ ...point })),
      rules: RULES.map(rule => ({ ...rule })), signals: SIGNALS.map(signal => ({ ...signal })), sprt: { ...this.sprt }, limits: { ...LIMITS },
      model: { kind: 'Deterministic software-in-the-loop', description: 'Two 500 kbit/s classical CAN segments, identifier arbitration, bounded queues, explicit security rules, asynchronous learned analyst, and independent safety acknowledgment. No physical CAN or actuator access.' },
    };
  }

  report() {
    return {
      ...this.snapshot(), frames: this.getFrames(), events: this.events.values().map(event => ({ ...event })),
      provenance: { mode: this.mode, evaluation: this.mode === 'trace' ? 'Imported traffic compared with the declared synthetic signal schema' : 'Seeded synthetic evaluation', training: 'Separate seeded synthetic clean trace; no evaluation labels or attack schedule supplied to detectors', trainingSeed: (this.seed ^ 0xC0FFEE91) >>> 0, hostTiming: 'Measured JavaScript gateway inspection wall-clock time on this computer; excludes UI, transport and synthetic training', modeledTiming: 'CAN serialization, queue delay, 18 us base gateway service plus 4 us per failed check, 40 ms analyst delay and 60 ms safety acknowledgment are assumptions, not hardware measurements' },
      configuration: { busBitrate: 500000, queueCapacityPerSegment: QUEUE_CAPACITY, analystQueueCapacity: ANALYST_CAPACITY, analystDelayMs: 40, safetyAcknowledgmentMs: ACK_MS, recoveryQuietMs: QUIET_MS, fixedStepMs: 1, sprt: { ...SPRT, binMs: 100, decisions: { ...this.sprtDecisions } } },
      signalSchema: { byteOrder: 'little-endian', length: 8, primary: 'bytes0..1 unsigned16, scale0.01; steering subtracts180 degrees', auxiliary: 'bytes2..3 unsigned16, scale0.01 except Powertrain RPM scale1', reserved: 'bytes4..6 must be zero', counter: 'byte7, increment modulo256', signals: SIGNALS.map(signal => ({ ...signal, fields: { 288: ['brakePct', 'speedKph'], 304: ['steeringDeg', 'speedKph'], 512: ['speedKph', 'rpm'], 768: ['batteryPct', 'temperatureC'], 1024: ['bodyFlags', 'supplyVoltage'], 1280: ['volumePct', 'source'] }[signal.id] })) },
      retention: { retainedFrames: this.frames.length, completedFrames: this.metrics.forwarded + this.metrics.blocked + this.metrics.dropped, omittedFrames: Math.max(0, this.metrics.forwarded + this.metrics.blocked + this.metrics.dropped - this.frames.length), snapshotFrames: 160, counterScope: 'Cumulative; only BLOCK is positive detection. DROP is an availability loss: attack drops count as false negatives, normal drops as detector negatives. Unknown labels are excluded.' },
      limitations: ['Synthetic schema and traffic are not validation on real vehicles or public CAN datasets.', 'Rolling counters and plausibility checks cannot authenticate a source; coordinated schema-valid attacks can evade them.', 'The learned model detects deviations from the training distribution and may miss attacks or reject unseen legitimate behavior.', 'Bus stuffing, arbitration and service time are simplified; host timing cannot establish MCU real-time deadlines.', 'Degraded operation models a motor-enable latch and gradual speed decay, not certified vehicle control.', 'This laboratory is not safety-certified or suitable for connection to a vehicle.'],
    };
  }
}
