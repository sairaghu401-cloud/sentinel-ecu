import { Simulation } from '/engine/simulation.js';
import { observePresentation, presentationSnapshot } from '/engine/presentation-observer.js';
let sim, step = null, elapsed = 0;
const plans = {
  1: { type: 'fuzzing', targetId: 0x120, intensity: 1 },
  2: { type: 'flooding', targetId: 0x400, intensity: 2 },
  3: { type: 'stealth', targetId: 0x300, intensity: 1 },
  4: { type: 'payload', targetId: 0x120, intensity: 5 },
};
function start(key) {
  if (!sim) sim = observePresentation(new Simulation({ seed: 42, profile: 'urban' }));
  else sim.reset({ seed: 42, profile: 'urban' });
  step = key; elapsed = 0;
  sim.advance(1500); sim.injectAttack({ ...plans[key], durationMs: key === 4 ? 8000 : 60000 });
  sim.advance(key === 3 ? 2600 : key === 4 ? 1400 : 600); sim.setRunning(true);
}
function post() {
  self.postMessage({ type: 'live', session: 'preview', ...sim.snapshot(), ...presentationSnapshot(sim) });
}
self.onmessage = ({ data }) => {
  if (data.pause) { sim?.setRunning(false); return; }
  const key = Math.max(1, Math.min(4, Number(data.step) || 1));
  if (key !== step) start(key); else sim.setRunning(true);
  post();
};
setInterval(() => {
  if (!sim?.running) return;
  try { sim.advance(100); elapsed += 100; if (elapsed > (step === 4 ? 12000 : 55000)) start(step); post(); }
  catch (e) { sim.setRunning(false); self.postMessage({ type: 'connection', online: false, error: e.message }); }
}, 100);
