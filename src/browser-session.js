import { observePresentation, presentationSnapshot } from './presentation-observer.js';
import { Simulation, SCENARIOS, SIGNALS, INTENSITY_PROFILES, describeAttackIntensity } from './simulation.js';
import { parseTrace, framesToCsv } from './datasets.js';

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

/** One independent, in-memory session per browser tab. Uses the same engine as Node. */
export class BrowserSession {
  constructor() { this.reset(); }
  reset(seed = 42, profile = 'urban') {
    integer(seed, 0, 0xffffffff, 'Seed');
    if (!['urban', 'highway'].includes(profile)) throw new RangeError('Profile must be urban or highway.');
    this.sim = observePresentation(new Simulation({ seed, profile }));
    this.session = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), source: 'synthetic' };
    this.provenance = {};
  }
  snapshot() {
    const state = this.sim.snapshot();
    return { ...state, presentation: presentationSnapshot(this.sim), frames: state.frames.slice(0, 150), events: state.events.slice(0, 60),
      sessionId: this.session.id, source: this.session.source, storage: { enabled: false, path: null, error: null } };
  }
  tick() { if (this.sim.running) this.sim.advance(Math.round(50 * this.sim.speed)); }
  requireSynthetic() {
    if (this.session.source === 'imported') throw new Error('Reset to a new simulation before running, stepping, or injecting an attack.');
  }
  request(path, input) {
    switch (path) {
      case '/api/state': return this.snapshot();
      case '/api/catalog': return { signals: SIGNALS, scenarios: SCENARIOS.map(s => ({ ...s,
        intensities: INTENSITY_PROFILES.map(p => describeAttackIntensity(s.id, p.level)) })) };
      case '/api/control': {
        switch (input.action) {
          case 'start': this.requireSynthetic(); this.sim.setRunning(true); break;
          case 'pause': this.sim.setRunning(false); break;
          case 'step':
            this.requireSynthetic();
            if (this.sim.running) throw new Error('Pause the simulation before stepping.');
            this.sim.advance(integer(input.milliseconds ?? 100, 1, 10000, 'Step duration')); break;
          case 'speed': this.sim.setSpeed(input.speed); break;
          case 'analyst': this.sim.setAnalyst(input.connected); break;
          case 'clear-attacks': this.sim.clearAttacks(); break;
          case 'recover':
            if (!this.sim.snapshot().safety.recoveryEligible) throw new Error('Clear attacks and run through the quiet interval before recovery.');
            this.sim.requestRecovery(); break;
          case 'reset': this.reset(input.seed ?? 42, input.profile ?? 'urban'); break;
          default: throw new Error('Unknown simulation action.');
        }
        return this.snapshot();
      }
      case '/api/attack': this.requireSynthetic(); this.sim.injectAttack(input); return this.snapshot();
      case '/api/import': {
        const parsed = parseTrace(input.text, input.format);
        const next = observePresentation(new Simulation({ seed: 42, profile: 'urban' }));
        for (const frame of parsed.frames) next.ingest(frame);
        next.advance(500); next.setRunning(false);
        this.sim = next;
        this.session = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), source: 'imported' };
        this.provenance = { format: parsed.format, rows: parsed.frames.length, warnings: parsed.warnings };
        return { snapshot: this.snapshot(), summary: { frames: parsed.frames.length, ...this.provenance } };
      }
      case '/api/export': {
        const format = input.format;
        if (!['json', 'csv'].includes(format)) throw new Error('Export format must be json or csv.');
        const report = this.sim.report();
        return { filename: `sentinel-${this.session.id}.${format}`,
          type: format === 'csv' ? 'text/csv' : 'application/json',
          content: format === 'csv' ? framesToCsv(this.sim.getFrames()) : JSON.stringify({ ...report,
            schemaVersion: 1, session: { ...this.session }, exportedAt: new Date().toISOString(),
            snapshot: this.sim.snapshot(), frames: this.sim.getFrames(),
            provenance: { ...report.provenance, ...this.provenance, kind: this.session.source,
              environment: { runtime: 'browser-worker' },
              storage: 'In memory in this browser tab. Reload starts a new session. Imported traces are not uploaded.',
              timing: 'CAN, queueing and safety timing are modeled. Host processing is measured in the browser, not on an MCU.',
              retention: 'Frames and events are bounded recent windows; counters cover the entire run.' } }, null, 2) };
      }
      default: throw new Error('Unknown browser session request.');
    }
  }
}
