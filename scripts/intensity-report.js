import { mkdir, writeFile } from 'node:fs/promises';
import { Simulation, SCENARIOS, INTENSITY_PROFILES, describeAttackIntensity } from '../src/simulation.js';

// A fixed comparison experiment, not a promised severity classification.
const results = [];
for (const scenario of SCENARIOS) {
  for (const profile of INTENSITY_PROFILES) {
    const sim = new Simulation({ seed: 42 }); sim.advance(1000);
    const before = sim.snapshot().metrics;
    sim.injectAttack({ type: scenario.id, targetId: 0x300, durationMs: 5000, intensity: profile.level });
    let peakRisk = 0;
    for (let i = 0; i < 50; i++) { sim.advance(100); peakRisk = Math.max(peakRisk, sim.snapshot().risk); }
    const state = sim.snapshot();
    results.push({ scenario: scenario.id, ...describeAttackIntensity(scenario.id, profile.level),
      receivedDuringAttack: state.metrics.received - before.received,
      blockedDuringAttack: state.metrics.blocked - before.blocked,
      droppedDuringAttack: state.metrics.dropped - before.dropped,
      peakRisk, finalRisk: state.risk, gatewayStatus: state.status,
      piOutliers: state.analyst.outliers, safetyState: state.safety.state });
  }
}
const report = { seed: 42, profile: 'urban', targetId: '0x300', warmupMs: 1000, durationMs: 5000,
  notes: ['Synthetic battery-target comparison; not performance on all targets or durations.', 'Counters include background traffic during the attack window. Pending frames are not drained.', 'Intensity controls the generator. Detectors and safety consume observed evidence, never the intensity label.'], results };
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/intensity-comparison.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(results.filter(row => ['payload', 'flooding'].includes(row.scenario)), null, 2));
