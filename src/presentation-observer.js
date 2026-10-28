// Read-only instrumentation for the message journey. Never changes a verdict,
// queue, clock, model PRNG or safety state. Retention stays bounded at any load.
const observations = new WeakMap();
export function observePresentation(sim) {
  if (observations.has(sim)) return sim;
  const info = { drops: { ingress: 0, egress: 0 }, reasons: new Map(), samples: new Map(), notable: [] };
  observations.set(sim, info);
  const record = sim._record.bind(sim);
  sim._record = (...args) => {
    const result = record(...args);
    const ring = sim.frames;
    const rec = ring.items[(ring.next - 1 + ring.capacity) % ring.capacity];
    if (rec.decision === 'DROP') info.drops[rec.reasons[0]?.startsWith('Egress') ? 'egress' : 'ingress']++;
    if (rec.decision === 'BLOCK') {
      const reason = rec.reasons[0];
      info.reasons.set(reason, (info.reasons.get(reason) || 0) + 1);
    }
    if (rec.decision !== 'FORWARD') {
      info.notable.push(rec);
      if (info.notable.length > 60) info.notable.shift();
    }
    const category = rec.decision === 'DROP'
      ? `DROP:${rec.reasons[0]?.startsWith('Egress') ? 'egress' : 'ingress'}`
      : `${rec.decision}:${rec.label}:${rec.id}`;
    // One recent record per signal/origin/outcome; cap even arbitrary imported IDs.
    info.samples.delete(category);
    info.samples.set(category, rec);
    if (info.samples.size > 24) info.samples.delete(info.samples.keys().next().value);
    return result;
  };
  const reset = sim.reset.bind(sim);
  sim.reset = (...args) => {
    const result = reset(...args);
    info.drops = { ingress: 0, egress: 0 }; info.reasons.clear(); info.samples.clear(); info.notable = [];
    return result;
  };
  return sim;
}
export function presentationSnapshot(sim) {
  const info = observations.get(sim);
  return info ? structuredClone({ drops: { ...info.drops }, blockReasons: [...info.reasons].sort((a, b) => b[1] - a[1]),
    samples: [...info.samples.values()].sort((a, b) => a.seq - b.seq), notable: info.notable.slice().reverse() })
    : { drops: { ingress: 0, egress: 0 }, blockReasons: [], samples: [], notable: [] };
}
