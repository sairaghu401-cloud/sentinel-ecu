const browserMode = document.documentElement.dataset.runtime === 'browser';
const browserRuntime = browserMode ? await import('./browser-runtime.js') : null;
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const EASE = 'cubic-bezier(.2,.8,.2,1)';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const LEVELS = ['OBSERVE', 'WARN', 'FILTER', 'REQUEST_DEGRADE'];
// One attention animation at a time; a higher priority channel finishes a lower one.
const ATTENTION_PRIORITY = { inspector: 1, chart: 1, timeline: 1, safety: 2, gateway: 3 };
const CHART = { width: 800, height: 186, left: 40, right: 12, top: 12, bottom: 30 };
const CHART_SERIES = [['received', '#b9561b'], ['forwarded', '#507b9b'], ['blocked', '#b33e36']];
const EVENT_HIGHLIGHT = { info: '#eef1f4', warning: '#fbeedb', critical: '#f9e3dc' };
const SAFETY_BANNERS = { REQUESTED: 'Degradation requested', DEGRADED: 'Degraded · safety latched', NORMAL: 'Normal operation restored' };
const formatNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const viewCopy = {
  overview: ['Overview', 'Vehicle security workbench', 'A live CAN network. Six attack scenarios. Every gateway decision recorded.'],
  traffic: ['Traffic inspector', 'Network traffic', 'Inspect the payload, timing, and rule evidence behind each decision.'],
  validation: ['Validation', 'Test results', 'Compare the gateway with an ID allowlist on identical synthetic traffic.'],
  guide: ['Lab guide', 'Laboratory handbook', 'Set up an experiment and understand the limits of the model.'],
};
const fallbackScenarios = [
  { id: 'spoofing', name: 'ID spoofing', description: 'Inject forged control frames using an allowed CAN identifier.' },
  { id: 'replay', name: 'Replay attack', description: 'Resend old frames to challenge freshness and sequence checks.' },
  { id: 'flooding', name: 'Bus flooding', description: 'Overload the modeled bus with high-rate adversarial traffic.' },
  { id: 'fuzzing', name: 'Frame fuzzing', description: 'Generate malformed or unexpected frames to exercise gateway rules.' },
  { id: 'payload', name: 'Payload manipulation', description: 'Alter control data to test range, integrity, and plausibility checks.' },
  { id: 'stealth', name: 'Stealth drift', description: 'Apply gradual changes to challenge anomaly and accumulated evidence detection.' },
];

let state = null;
let connected = false;
let activeView = 'overview';
let pendingControl = false;
let settingsDirty = false;
let scenarios = fallbackScenarios;
let validationResult = null;
let validating = false;
let importing = false;
let selectedFrame = null;
let heldFrames = null;
let notificationTimer;
let eventSource;
let pollPending = false;
let lastEventSignature = '';
let lastFrameSignature = '';
let lastRulesSignature = '';
let validationStatusTimer;
let gatewayLevel = null;
let gaugeShiftTimer;
let safetyState = null;
let shownEventIds = [];
let frameRows = new Map();
let lastFrameSeq = -1;
let chartNodes = null;
let chartDrawn = false;
let attackWindows = new Map();
const attention = { owner: null, until: 0, animations: [] };
const INJECT_HOLD_MS = 600, INJECT_ARM_MS = 5000, INJECT_SLOP_PX = 16;
const inject = { holdTimer: 0, armTimer: 0, releaseTimer: 0, held: false, ring: [], pointerId: null, token: 0 };

function number(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
function count(value) { return formatNumber.format(number(value)); }
function percent(value) { return value == null ? '—' : `${(number(value) * 100).toFixed(1)}%`; }
function hex(value) { return `0x${number(value).toString(16).toUpperCase().padStart(3, '0')}`; }
function clock(milliseconds) {
  const ms = Math.max(0, Math.floor(number(milliseconds)));
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor(ms / 1000) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function text(id, value) { $(id).textContent = String(value); }
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = String(content);
  return node;
}
function svgElement(tag, attributes = {}, content) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (content != null) node.textContent = String(content);
  return node;
}
// Motion marks real model state changes only. Reduced motion receives the end state instantly.
function play(node, keyframes, options) {
  if (reducedMotion.matches || !node || typeof node.animate !== 'function') return null;
  return node.animate(keyframes, options);
}
function attend(channel, duration, start) {
  if (reducedMotion.matches) return false;
  const now = performance.now();
  const other = now < attention.until && attention.owner !== channel ? attention.owner : null;
  if (other && ATTENTION_PRIORITY[other] >= ATTENTION_PRIORITY[channel]) return false;
  if (other) attention.animations.forEach(animation => animation.finish());
  attention.animations = attention.owner === channel ? attention.animations.filter(animation => animation.playState === 'running') : [];
  attention.owner = channel;
  attention.until = Math.max(other ? 0 : attention.until, now + duration);
  attention.animations.push(...start().filter(Boolean));
  return true;
}
function notify(message, error = false) {
  clearTimeout(notificationTimer);
  text('notification-text', message);
  $('notification').classList.toggle('error', error);
  $('notification').hidden = false;
  if (!error) notificationTimer = setTimeout(() => { $('notification').hidden = true; }, 6500);
}
function connectionStatus(online) {
  connected = online;
  const node = $('connection-state');
  node.className = `connection ${online ? 'online' : 'offline'}`;
  node.lastElementChild.textContent = browserMode ? (online ? 'Browser simulation ready' : 'Simulation unavailable') : online ? 'Server connected' : 'Server offline';
  $('connection-banner').hidden = online;
  text('connection-detail', state ? 'The simulation server is unavailable. Values below are the last received state.' : 'The simulation server is unavailable. Start the local server, then reconnect.');
  if (browserMode) text('connection-detail', 'The browser simulation is unavailable. Reload the page to start a fresh session.');
  if (!online) {
    text('run-state', state ? 'LAST RECEIVED STATE' : 'SERVER UNAVAILABLE');
    $('run-state').classList.remove('running');
    $('network-visual').classList.remove('running');
    $('network-dot').classList.remove('running');
    text('network-state', 'LINK LOST');
    text('map-status', 'Offline · last received state');
  }
  updateControls();
}

async function api(path, body) {
  if (browserRuntime) return browserRuntime.request(path, body);
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(path === '/api/validation' ? 120000 : 30000),
    });
  } catch (error) {
    connectionStatus(false);
    throw new Error(error.name === 'TimeoutError' ? 'The server took too long to respond. Reconnect and try again.' : 'Cannot reach the simulation server. Start the local server and reconnect.');
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('The server returned an unreadable response. Reconnect and try again.'); }
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}).`);
  return result;
}

function updateControls() {
  const disabled = !connected || !state || pendingControl || importing;
  const imported = state?.source === 'imported';
  for (const id of ['reset', 'reset-import']) $(id).disabled = disabled;
  for (const id of ['toggle-run', 'speed', 'analyst-toggle', 'inject-attack']) $(id).disabled = disabled || imported;
  if ($('inject-attack').disabled && ($('inject-attack').hasAttribute('data-armed') || (inject.pointerId !== null && !inject.held))) { endInjectHold(); setInjectArmed(false); }
  $('step').disabled = disabled || imported || Boolean(state?.running);
  $('clear-attacks').disabled = disabled || imported || !state?.activeAttacks?.length;
  $('recover').disabled = disabled || imported || !state?.safety?.recoveryEligible;
  $('run-validation').disabled = !connected || validating;
  $('import-trigger').disabled = !connected || importing;
  // Keep the user's switch position while its request is in flight. A confirmed
  // snapshot (or a failed request) reconciles it when pendingControl clears.
  if (!pendingControl) $('analyst-toggle').checked = state?.analyst?.connected ?? true;
  $('toggle-run').setAttribute('aria-label', imported ? 'Imported replay completed. Reset to run a new simulation.' : state?.running ? 'Pause simulation' : 'Run simulation');
  text('run-label', imported ? 'Replay complete' : state?.running ? 'Pause simulation' : 'Run simulation');
  text('run-icon', state?.running ? 'Ⅱ' : '▶');
  $('speed').value = String(state?.speed ?? 1);
}

// One underline element slides between tabs; geometry changes from resizing or fonts move it instantly.
function placeTabIndicator(slide) {
  const tab = document.querySelector('.nav-item.active');
  if (!tab) return;
  const inset = parseFloat(getComputedStyle(tabIndicator.parentElement).getPropertyValue('--tab-inset')) || 0;
  const transform = `translateX(${tab.offsetLeft + inset}px) scaleX(${Math.max(0, tab.offsetWidth - inset * 2) / 100})`;
  if (slide && tabIndicator.style.transform) { tabIndicator.style.transform = transform; return; }
  tabIndicator.classList.add('instant');
  tabIndicator.style.transform = transform;
  void tabIndicator.offsetWidth;
  tabIndicator.classList.remove('instant');
}

function setView(name, focus = false) {
  if (!viewCopy[name]) name = 'overview';
  const changed = name !== activeView;
  activeView = name;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`panel-${tab.dataset.tab}`).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  placeTabIndicator(changed);
  text('breadcrumb-view', viewCopy[name][0]);
  text('page-title', viewCopy[name][1]);
  text('page-description', viewCopy[name][2]);
  document.title = `${viewCopy[name][0]} · Sentinel ECU`;
  if (!reducedMotion.matches) {
    const panel = $(`panel-${name}`);
    panel.getAnimations().forEach(animation => animation.cancel());
    panel.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 300, easing: EASE });
  }
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'traffic') renderFrames(true);
}

function renderSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.metrics) return;
  const previousSession = state?.sessionId;
  state = { ...snapshot, sessionId: snapshot.sessionId || state?.sessionId };
  connectionStatus(true);
  const sessionChanged = Boolean(previousSession && state.sessionId && previousSession !== state.sessionId);
  if (sessionChanged) {
    selectedFrame = null;
    holdFrames(false);
    $('frame-detail').hidden = true;
    lastFrameSignature = '';
    lastEventSignature = '';
    chartDrawn = false;
  }
  if (!settingsDirty) {
    $('profile').value = state.profile;
    $('seed').value = String(state.seed);
  }
  text('model-time', clock(state.timeMs));
  text('run-state', state.source === 'imported' ? 'IMPORTED · COMPLETE' : state.running ? `RUNNING · ${state.speed}× SPEED` : 'PAUSED');
  $('imported-notice').hidden = state.source !== 'imported';
  $('storage-warning').hidden = !state.storage?.error;
  text('storage-warning-text', state.storage?.error ? `${state.storage.error} You can still export the current session from the Traffic inspector.` : '');
  $('run-state').classList.toggle('running', Boolean(state.running));
  text('metric-received', count(state.metrics.received));
  text('metric-forwarded', count(state.metrics.forwarded));
  text('metric-blocked', count(state.metrics.blocked));
  text('block-rate', `${(state.metrics.received ? state.metrics.blocked / state.metrics.received * 100 : 0).toFixed(1)}%`);
  text('drop-count', state.metrics.dropped ? `· ${count(state.metrics.dropped)} dropped` : '');
  text('metric-risk', Math.round(number(state.risk)));
  text('metric-latency', count(state.metrics.simulatedLatencyP95Us));
  text('host-latency', count(state.metrics.processingP95Us));
  text('status-badge', String(state.status).replaceAll('_', ' '));
  $('status-badge').className = `status-badge ${String(state.status).toLowerCase()}`;
  $('risk-fill').style.transform = `scaleX(${Math.max(0, Math.min(100, number(state.risk))) / 100})`;
  $('risk-fill').style.background = number(state.risk) > 65 ? 'var(--gauge-high)' : number(state.risk) > 25 ? 'var(--gauge-mid)' : 'var(--gauge-low)';
  text('bus-load', `${number(state.metrics.busLoadPct).toFixed(1)}%`);
  text('queue-depth', count(state.metrics.queueDepth));
  text('network-state', state.source === 'imported' ? 'REPLAY COMPLETE' : state.running ? 'TRAFFIC LIVE' : 'PAUSED');
  $('network-dot').classList.toggle('running', Boolean(state.running));
  $('network-visual').classList.toggle('running', Boolean(state.running));
  const gatewayModes = { OBSERVE: 'Rules active · observing', WARN: 'Rules active · warning', FILTER: 'Rules active · filtering', REQUEST_DEGRADE: 'Degradation requested' };
  text('gateway-mode', gatewayModes[state.status] || 'Gateway active');
  renderGatewayLevel(sessionChanged);
  const analyst = state.analyst;
  const holds = analyst.activeHolds || [];
  const analystStatus = !analyst.connected ? 'Offline' : holds.length ? 'Payload anomaly detected' : !analyst.processed ? 'Waiting for payloads' : 'Monitoring · no active payload hold';
  text('analyst-assessment', analystStatus);
  $('analyst-assessment').dataset.level = !analyst.connected ? 'offline' : holds.length ? 'alert' : 'monitoring';
  text('analyst-evidence', `${count(analyst.processed)} payloads examined · ${count(analyst.outliers)} outliers this session${holds.length ? ` · holding ${holds.map(hold => hex(hold.id)).join(', ')}` : ''}`);
  text('analyst-node-status', analyst.connected ? (holds.length ? 'Payload anomaly · hold active' : 'Monitoring payloads') : 'Offline · local rules continue');
  text('analyst-description', analyst.connected ? `${analyst.trained ? 'Model ready' : 'Training'} · ${count(analyst.trainingSamples)} samples` : 'Offline · gateway rules remain active');
  text('analyst-footer', analyst.connected ? 'Analyst connected' : 'Analyst offline · rules active');
  $('analyst-footer').style.color = analyst.connected ? '' : 'var(--amber)';
  $('analyst-node').style.opacity = analyst.connected ? '1' : '.55';
  $('analyst-link').style.opacity = analyst.connected ? '1' : '.25';
  $('analyst-dot').style.fill = analyst.connected ? 'var(--cyan)' : 'var(--amber)';
  const gatewayLabels = { OBSERVE: 'Monitoring traffic', WARN: 'Suspicious traffic detected', FILTER: 'Threat detected · filtering', REQUEST_DEGRADE: 'Threat detected · safety requested' };
  text('gateway-assessment', gatewayLabels[state.status] || state.status);
  $('gateway-assessment').dataset.level = state.status === 'OBSERVE' ? 'monitoring' : 'alert';
  text('gateway-evidence', `${count(state.metrics.blocked)} blocked · ${count(state.metrics.dropped)} dropped · threat score ${Math.round(number(state.risk))}/100`);
  const safetyNames = { NORMAL: 'Shutdown not requested', REQUESTED: 'Degradation requested', DEGRADED: 'Degraded · safety latched' };
  text('safety-state', safetyNames[state.safety.state] || state.safety.state);
  const criteria = state.safety.requestCriteria;
  const missing = criteria ? [!criteria.elevatedRisk && 'threat score ≥ 65', !criteria.sustainedThreat && 'sustained threat confirmation', !criteria.criticalSignalEvidence && 'recent brake, steering or powertrain evidence'].filter(Boolean) : [];
  text('safety-reason', state.safety.state !== 'NORMAL' ? state.safety.reason : state.status === 'OBSERVE' ? 'Independent vehicle safety task is standing by. This does not describe the Pi’s detection result.' : `Gateway protection is active. Shutdown requires all safety criteria.${missing.length ? ` Still required: ${missing.join('; ')}.` : ' Awaiting the next safety evaluation.'}`);
  text('safety-node-status', safetyNames[state.safety.state] || state.safety.state);
  $('safety-node').style.setProperty('--safety-color', state.safety.state === 'NORMAL' ? 'var(--dim)' : 'var(--amber)');
  $('safety-node').querySelector('rect').style.stroke = state.safety.state === 'NORMAL' ? '' : 'var(--amber)';
  const safetyIcon = $('safety-icon');
  safetyIcon.textContent = state.safety.state === 'NORMAL' ? '—' : '!';
  safetyIcon.style.color = state.safety.state === 'NORMAL' ? 'var(--muted)' : 'var(--amber)';
  safetyIcon.style.background = state.safety.state === 'NORMAL' ? '' : '#fff0df';
  text('recovery-help', state.safety.recoveryEligible ? 'Quiet interval complete. The independent safety task can recover.' : state.safety.state === 'NORMAL' ? 'Recovery becomes available after a degradation and a quiet interval.' : 'Clear all attacks and let the model run through a quiet interval before recovering.');
  text('vehicle-speed', number(state.vehicle.speedKph).toFixed(1));
  text('vehicle-rpm', count(state.vehicle.rpm));
  text('vehicle-brake', `${number(state.vehicle.brakePct).toFixed(0)}%`);
  text('vehicle-steering', `${number(state.vehicle.steeringDeg).toFixed(1)}°`);
  text('vehicle-battery', `${number(state.vehicle.batteryPct).toFixed(1)}%`);
  text('vehicle-motor', state.vehicle.motorEnabled ? 'Enabled' : 'Disabled');
  text('twin-brake', `${number(state.vehicle.brakePct).toFixed(0)}%`);
  text('twin-steering', `${number(state.vehicle.steeringDeg).toFixed(1)}°`);
  text('twin-rpm', `${count(state.vehicle.rpm)} rpm`);
  text('twin-battery', `${number(state.vehicle.batteryPct).toFixed(1)}%`);
  $('network-visual').dataset.degraded = String(state.safety.state !== 'NORMAL');
  text('map-status', state.safety.state !== 'NORMAL' ? 'Safety intervention active' : state.status !== 'OBSERVE' ? (state.status === 'FILTER' ? 'Threat detected · gateway filtering' : 'Suspicious traffic detected') : state.source === 'imported' ? 'Completed trace replay' : state.running ? 'Model running · CAN active' : 'Model paused');
  $('vehicle-motor').style.color = state.vehicle.motorEnabled ? 'var(--cyan)' : 'var(--amber)';
  text('ecu-detail', state.vehicle.motorEnabled ? 'Motor enabled' : 'Motor off · safe state');
  $('ecu-dot').style.fill = state.vehicle.motorEnabled ? 'var(--cyan)' : 'var(--amber)';
  text('session-label', state.sessionId ? `Session ${String(state.sessionId).slice(0, 12)}` : `Seed ${state.seed} · ${state.profile}`);
  text('attack-hint', state.source === 'imported' ? 'Reset to a new simulation to inject an attack.' : state.running ? 'Attacks affect the simulated network only.' : 'Run the model to advance an injected attack.');
  // Live only while an injected source is actually generating frames: scheduled and running.
  $('main-content').dataset.attackLive = String(Boolean(state.running && state.source !== 'imported' && state.activeAttacks?.length));
  renderAttacks();
  trackAttackWindows(sessionChanged);
  renderChart();
  renderSafetyBanner(sessionChanged);
  renderEvents();
  renderRules();
  if (activeView === 'traffic') renderFrames();
  updateControls();
  if (document.body.classList.contains('awaiting-snapshot')) {
    // Commit the first real values, then drop the placeholders, then enable transitions:
    // each step is flushed separately so nothing animates out of the loading state.
    void document.body.offsetWidth;
    document.body.classList.remove('awaiting-snapshot');
    void document.body.offsetWidth;
    document.body.classList.add('motion-ready');
  }
}

// The gateway node and gauge share one 350 ms level transition; only escalation pulses.
function renderGatewayLevel(sessionChanged) {
  const level = LEVELS.includes(state.status) ? state.status : 'OBSERVE';
  const previous = sessionChanged ? null : gatewayLevel;
  gatewayLevel = level;
  $('main-content').dataset.gatewayLevel = level.toLowerCase();
  if (!previous || previous === level) return;
  const meter = $('risk-fill').parentElement;
  meter.classList.add('level-shift');
  clearTimeout(gaugeShiftTimer);
  gaugeShiftTimer = setTimeout(() => meter.classList.remove('level-shift'), 350);
  if (LEVELS.indexOf(level) <= LEVELS.indexOf(previous) || activeView !== 'overview') return;
  attend('gateway', 600, () => [play(document.querySelector('.gateway-pulse'), [{ opacity: 0.85, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.6)' }], { duration: 600, easing: EASE })]);
}

function renderAttacks() {
  const container = $('active-attacks');
  const attacks = state.activeAttacks || [];
  container.hidden = !attacks.length;
  container.replaceChildren(...attacks.map((attack) => {
    const row = element('div', 'active-attack');
    const scenario = scenarios.find((entry) => entry.id === attack.type);
    const details = element('div', 'attack-details');
    details.append(element('strong', '', `${scenario?.name || attack.type} · ${hex(attack.targetId)}`));
    details.append(element('span', `attack-strength strength-${attack.intensity}`, `${attack.strength?.label || 'Intensity'} · ${attack.intensity ?? '—'}/5`));
    details.append(element('p', '', attack.strength?.description || 'Intensity details unavailable'));
    row.append(details, element('span', 'attack-remaining', `${Math.max(0, (attack.endsAtMs - state.timeMs) / 1000).toFixed(1)}s left`));
    return row;
  }));
}

// Attack windows come only from the engine's injected-attack schedule, never from frame labels.
function trackAttackWindows(sessionChanged) {
  if (sessionChanged) attackWindows = new Map();
  const now = number(state.timeMs);
  const live = new Set();
  for (const attack of state.activeAttacks || []) {
    const key = `${attack.type}:${attack.targetId}:${attack.startsAtMs}`;
    live.add(key);
    attackWindows.set(key, { start: number(attack.startsAtMs), end: Math.min(number(attack.endsAtMs), now), scheduledEnd: number(attack.endsAtMs), open: true });
  }
  for (const [key, window] of attackWindows) {
    if (!window.open && window.end < now - 120000) attackWindows.delete(key);
    if (!window.open || live.has(key)) continue;
    window.open = false;
    // Stopped early: use the engine's own "sources stopped" timestamp, else the last time it was seen running.
    const stopped = (state.events || []).find((event) => event.title === 'Attack sources stopped' && event.timestampMs >= window.start && event.timestampMs <= now);
    window.end = now >= window.scheduledEnd ? window.scheduledEnd : stopped ? number(stopped.timestampMs) : window.end;
  }
}

function chartScaffold(chart) {
  if (chartNodes && chart.contains(chartNodes.plot)) return chartNodes;
  const { width, height, left, right, top, bottom } = CHART;
  const plotW = width - left - right, plotH = height - top - bottom;
  const defs = svgElement('defs');
  const reveal = svgElement('rect', { class: 'chart-reveal', x: 0, y: 0, width, height });
  const clip = svgElement('clipPath', { id: 'chart-reveal' });
  clip.append(reveal);
  defs.append(clip);
  const windows = svgElement('g', { class: 'chart-attack-windows' });
  const grid = [], yLabels = [], xLabels = [];
  for (let line = 0; line <= 3; line++) {
    const yy = top + plotH - plotH * line / 3;
    grid.push(svgElement('line', { x1: left, x2: width - right, y1: yy, y2: yy, stroke: '#d9d9cf', 'stroke-width': 1, 'stroke-dasharray': '3 5' }));
    yLabels.push(svgElement('text', { x: left - 10, y: yy + 3, fill: '#596a7b', 'font-size': 9, 'font-family': 'Consolas, monospace', 'text-anchor': 'end' }));
  }
  for (let line = 0; line <= 4; line++) {
    xLabels.push(svgElement('text', { x: left + plotW * line / 4, y: height - 8, fill: '#596a7b', 'font-size': 9, 'font-family': 'Consolas, monospace', 'text-anchor': line === 0 ? 'start' : line === 4 ? 'end' : 'middle' }));
  }
  const plot = svgElement('g', { 'clip-path': 'url(#chart-reveal)' });
  const area = svgElement('path', { fill: '#b9561b', opacity: '.07' });
  const lines = {}, dots = {};
  plot.append(area);
  for (const [key, color] of CHART_SERIES) {
    lines[key] = svgElement('path', { fill: 'none', stroke: color, 'stroke-width': key === 'received' ? 2 : 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    dots[key] = svgElement('circle', { r: 3, fill: color, display: 'none' });
    plot.append(lines[key], dots[key]);
  }
  chart.replaceChildren(defs, windows, ...grid, ...yLabels, ...xLabels, plot);
  chartNodes = { reveal, windows, yLabels, xLabels, plot, area, lines, dots };
  return chartNodes;
}

// The chart's nodes persist; each update rewrites attributes in place, so nothing is torn down and redrawn.
function renderChart() {
  const chart = $('traffic-chart');
  const nodes = chartScaffold(chart);
  const series = (state?.series || []).slice(-60);
  const { width, left, right, top, bottom, height } = CHART;
  const plotW = width - left - right, plotH = height - top - bottom;
  const maxValue = Math.max(50, ...series.map((sample) => Math.max(number(sample.received), number(sample.forwarded), number(sample.blocked))));
  const maxY = Math.ceil(maxValue / 50) * 50;
  const start = series.length ? series[0].timeMs : 0;
  const end = series.length ? series[series.length - 1].timeMs : 10000;
  const x = (time, index) => series.length < 2 ? left + index * plotW : left + (time - start) / Math.max(1, end - start) * plotW;
  const y = (value) => top + plotH - number(value) / maxY * plotH;
  nodes.yLabels.forEach((label, line) => { label.textContent = count(maxY * line / 3); });
  nodes.xLabels.forEach((label, line) => { label.textContent = `${((start + (end - start) * line / 4) / 1000).toFixed(0)}s`; });
  for (const [key] of CHART_SERIES) {
    const points = series.map((sample, index) => [x(sample.timeMs, index), y(sample[key])]);
    const path = points.map(([xx, yy], index) => `${index === 0 ? 'M' : 'L'}${xx.toFixed(2)} ${yy.toFixed(2)}`).join(' ');
    nodes.lines[key].setAttribute('d', path);
    if (key === 'received') nodes.area.setAttribute('d', points.length > 1 ? `${path} L${points.at(-1)[0]} ${top + plotH} L${points[0][0]} ${top + plotH} Z` : '');
    nodes.dots[key].setAttribute('display', points.length === 1 ? 'inline' : 'none');
    if (points.length === 1) { nodes.dots[key].setAttribute('cx', points[0][0]); nodes.dots[key].setAttribute('cy', points[0][1]); }
  }
  const spans = [];
  if (series.length > 1) {
    for (const window of [...attackWindows.values()].sort((a, b) => a.start - b.start)) {
      const from = Math.max(window.start, start), to = Math.min(window.end, end);
      if (to <= from) continue;
      if (spans.length && from <= spans.at(-1)[1]) spans.at(-1)[1] = Math.max(spans.at(-1)[1], to);
      else spans.push([from, to]);
    }
  }
  nodes.windows.replaceChildren(...spans.flatMap(([from, to]) => [
    svgElement('rect', { class: 'chart-attack-window', x: x(from).toFixed(2), y: top, width: (x(to) - x(from)).toFixed(2), height: plotH }),
    svgElement('rect', { class: 'chart-attack-edge', x: x(from).toFixed(2), y: top, width: (x(to) - x(from)).toFixed(2), height: 2 }),
  ]));
  // Draw in the first time a line exists: a single one-second sample is only dots.
  if (!series.length) chartDrawn = false;
  else if (series.length > 1 && !chartDrawn) {
    chartDrawn = true;
    if (activeView === 'overview') attend('chart', 700, () => [play(nodes.reveal, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 700, easing: EASE })]);
  }
  chart.setAttribute('aria-label', series.length ? `CAN frames per simulated second from ${(start / 1000).toFixed(1)} to ${(end / 1000).toFixed(1)} seconds. Latest received ${series.at(-1).received}, forwarded ${series.at(-1).forwarded}, blocked ${series.at(-1).blocked}.${spans.length ? ` Shaded regions mark ${spans.length} injected attack window${spans.length === 1 ? '' : 's'}.` : ''}` : 'No traffic data. Run the simulation to populate the chart.');
  $('chart-empty').hidden = series.length > 0;
  $('chart-empty').querySelector('strong').textContent = state?.metrics?.received ? 'Collecting the first second' : 'No traffic recorded';
  $('chart-empty').lastElementChild.textContent = state?.metrics?.received ? 'Continue the model to build its traffic history.' : 'Run the simulation to observe live CAN traffic.';
  text('chart-window', `${(start / 1000).toFixed(0)}–${(series.length ? end / 1000 : 0).toFixed(0)} s`);
}

function eventRow(event) {
  const row = element('div', `event ${['warning', 'critical'].includes(event.severity) ? event.severity : 'info'}`);
  const content = element('div', 'event-text');
  content.append(element('div', 'event-title', event.title), element('div', 'event-detail', event.detail));
  const time = element('span', 'event-time', clock(event.timestampMs));
  time.title = 'Simulated time';
  row.append(element('i', 'event-marker'), content, time);
  return row;
}

function renderEvents() {
  const events = state.events || [];
  const signature = `${events.length}:${events[0]?.id}:${events[0]?.timestampMs}`;
  text('event-count', `${count(events.length)} events`);
  if (signature === lastEventSignature) return;
  const continuing = lastEventSignature !== '' && shownEventIds.length > 0;
  lastEventSignature = signature;
  if (!events.length) {
    shownEventIds = [];
    $('event-list').replaceChildren(element('div', 'empty-state compact', 'No security events yet. Start a run to generate evidence.'));
    return;
  }
  const visible = events.slice(0, 12);
  // Keep existing rows so a running highlight is not cut off; only genuinely new events are inserted.
  const freshCount = continuing ? visible.findIndex((event) => event.id === shownEventIds[0]) : -1;
  shownEventIds = visible.map((event) => event.id);
  if (freshCount < 0) { $('event-list').replaceChildren(...visible.map(eventRow)); return; }
  const fresh = visible.slice(0, freshCount);
  const rows = fresh.map(eventRow);
  $('event-list').prepend(...rows);
  while ($('event-list').children.length > visible.length) $('event-list').lastElementChild.remove();
  if (!rows.length || rows.length > 5 || activeView !== 'overview') return;
  attend('timeline', 1200, () => rows.flatMap((row, index) => [
    play(row, [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: EASE }),
    play(row, [{ backgroundColor: EVENT_HIGHLIGHT[fresh[index].severity] || EVENT_HIGHLIGHT.info }, { backgroundColor: 'rgba(255,255,255,0)' }], { duration: 1200, easing: 'ease-in' }),
  ]));
}

// One banner per observed safety transition; it remains until the safety state changes again.
function renderSafetyBanner(sessionChanged) {
  const current = state.safety?.state;
  const previous = sessionChanged ? null : safetyState;
  safetyState = current;
  const banner = $('safety-banner');
  if (sessionChanged) banner.hidden = true;
  if (!previous || previous === current || !SAFETY_BANNERS[current]) return;
  const restored = (state.events || []).find((event) => event.title === 'Normal operation restored');
  const at = { REQUESTED: state.safety.requestedAtMs, DEGRADED: state.safety.activatedAtMs, NORMAL: restored?.timestampMs }[current];
  banner.dataset.state = current.toLowerCase();
  text('safety-banner-text', SAFETY_BANNERS[current]);
  text('safety-banner-time', clock(at ?? state.timeMs));
  banner.hidden = false;
  if (activeView !== 'overview') return;
  attend('safety', 250, () => [play(banner, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 250, easing: EASE })]);
}

function renderRules() {
  const rules = state.rules || [];
  const signature = JSON.stringify(rules);
  if (signature === lastRulesSignature) return;
  lastRulesSignature = signature;
  $('rules-list').replaceChildren(...rules.map((rule) => {
    const node = element('div', 'rule');
    const copy = element('div');
    copy.append(element('strong', '', rule.name), element('p', '', rule.description));
    node.append(element('span', 'rule-check', rule.enabled ? '✓' : '−'), copy);
    return node;
  }));
}

function holdFrames(hold) {
  heldFrames = hold ? [...(state?.frames || [])] : null;
  text('hold-frames', hold ? 'Resume live view' : 'Hold view');
  $('hold-frames').setAttribute('aria-pressed', String(hold));
}

function frameRow(frame, changed) {
  const row = element('tr');
  row.dataset.seq = String(frame.seq);
  row.tabIndex = 0;
  row.setAttribute('aria-label', `Frame ${frame.seq}, ${hex(frame.id)}, ${frame.decision}. View evidence.`);
  row.append(element('td', '', clock(frame.timestampMs)), element('td', '', hex(frame.id)));
  const signal = element('td');
  const bytes = (frame.data || []).map((byte) => number(byte).toString(16).toUpperCase().padStart(2, '0'));
  const marked = changed?.some(Boolean);
  const payload = element('span', 'frame-payload', marked ? null : bytes.join(' ') || 'Empty payload');
  if (marked) bytes.forEach((byte, index) => { if (index) payload.append(' '); payload.append(changed[index] ? element('span', 'byte-changed', byte) : byte); });
  signal.append(element('span', 'frame-signal', frame.signal || 'Unknown signal'), payload);
  const decisionCell = element('td');
  decisionCell.append(element('span', `decision ${String(frame.decision).toLowerCase()}`, frame.decision));
  const labelCell = element('td');
  labelCell.append(element('span', `ground-truth ${frame.label === 'attack' ? 'attack' : ''}`, frame.label || 'unknown'));
  row.append(signal, decisionCell, element('td', '', Math.round(number(frame.risk))), labelCell);
  const select = () => { selectedFrame = frame; if (!heldFrames) holdFrames(true); renderFrameDetail(); renderFrames(true); };
  row.addEventListener('click', select);
  row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  return row;
}

// Per new frame, mark the bytes that differ from the previous retained frame with the same CAN ID.
function byteChanges(frames, fresh) {
  const wanted = new Set(fresh.map((frame) => frame.seq));
  const previous = new Map(), changes = new Map();
  for (let index = frames.length - 1; index >= 0; index--) {
    const data = frames[index].data || [];
    const before = previous.get(frames[index].id);
    if (before && wanted.has(frames[index].seq)) changes.set(frames[index].seq, data.map((byte, position) => byte !== before[position]));
    previous.set(frames[index].id, data);
  }
  return changes;
}

function renderFrames(force = false) {
  const search = $('frame-search').value.trim().toLowerCase();
  const decision = $('decision-filter').value;
  const label = $('label-filter').value;
  const frames = heldFrames || state?.frames || [];
  const signature = `${frames[0]?.seq}:${frames[0]?.timestampMs}:${frames.length}:${search}:${decision}:${label}`;
  if (!force && signature === lastFrameSignature) return;
  if (lastFrameSignature === '') { frameRows = new Map(); lastFrameSeq = -1; }
  lastFrameSignature = signature;
  const matching = frames.filter((frame) => {
    if (decision !== 'all' && frame.decision !== decision) return false;
    if (label !== 'all' && frame.label !== label) return false;
    return !search || `${hex(frame.id)} ${frame.id} ${frame.signal} ${(frame.reasons || []).join(' ')} ${(frame.data || []).map((byte) => number(byte).toString(16).padStart(2, '0')).join(' ')}`.toLowerCase().includes(search);
  });
  const visible = matching.slice(0, 100);
  text('frame-count', `${heldFrames ? 'Held · ' : ''}${count(matching.length)} matching / ${count(frames.length)} in view`);
  text('retention-note', `Showing ${visible.length} matching frames from the recent live window. Export buffer limit: ${count(state?.limits?.frameCapacity || 0)}.`);
  $('frames-empty').hidden = visible.length > 0;
  $('frames-empty').firstElementChild.textContent = frames.length ? 'No matching frames' : 'No frames to inspect';
  $('frames-empty').lastElementChild.textContent = frames.length ? 'Change the search or filters to inspect more traffic.' : 'Run the simulation, take a step, or import a CAN trace.';
  const focusedSequence = $('frames-body').contains(document.activeElement) ? document.activeElement.dataset.seq : null;
  // Only a live update may animate, and only a short readable burst. Filter changes and held views never do.
  const fresh = !force && !heldFrames && lastFrameSeq >= 0 ? visible.filter((frame) => frame.seq > lastFrameSeq) : [];
  const animate = fresh.length > 0 && fresh.length <= 5 && activeView === 'traffic';
  const changes = animate ? byteChanges(frames, fresh) : new Map();
  const rows = visible.map((frame) => {
    // Rows are reused by sequence number so an in-progress highlight survives the next update.
    if (!frameRows.has(frame.seq)) frameRows.set(frame.seq, frameRow(frame, changes.get(frame.seq)));
    const row = frameRows.get(frame.seq);
    row.className = selectedFrame?.seq === frame.seq ? 'selected' : '';
    return row;
  });
  $('frames-body').replaceChildren(...rows);
  const shown = new Set(visible.map((frame) => frame.seq));
  for (const seq of frameRows.keys()) if (!shown.has(seq)) frameRows.delete(seq);
  if (!heldFrames && frames.length) lastFrameSeq = Math.max(lastFrameSeq, frames[0].seq);
  if (animate) attend('inspector', 600, () => fresh.flatMap((frame) => {
    const row = frameRows.get(frame.seq);
    return [play(row, [{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: EASE }),
      ...[...row.querySelectorAll('.byte-changed')].map((byte) => play(byte, [{ backgroundColor: '#ffdcbc' }, { backgroundColor: 'rgba(255,220,188,0)' }], { duration: 600, easing: 'ease-in' }))];
  }));
  if (focusedSequence) [...$('frames-body').children].find((row) => row.dataset.seq === focusedSequence)?.focus({ preventScroll: true });
}

function renderFrameDetail() {
  if (!selectedFrame) return;
  const frame = selectedFrame;
  $('frame-detail').hidden = false;
  text('frame-detail-title', `Frame #${frame.seq} · ${hex(frame.id)} · ${frame.decision}`);
  const grid = element('dl', 'detail-grid');
  const details = [
    ['Timestamp (model)', clock(frame.timestampMs)], ['Data length', `${frame.dlc} bytes`],
    ['Anomaly score', number(frame.anomalyScore).toFixed(3)], ['Latency (model)', `${number(frame.latencyUs).toFixed(1)} μs`],
  ];
  for (const [name, value] of details) { const item = element('div'); item.append(element('dt', '', name), element('dd', '', value)); grid.append(item); }
  const reasons = element('div', 'frame-reasons');
  reasons.append(element('strong', '', 'Decision evidence'));
  const list = element('ul');
  for (const reason of frame.reasons?.length ? frame.reasons : ['No rule violations recorded.']) list.append(element('li', '', reason));
  reasons.append(list);
  $('frame-detail-content').replaceChildren(grid, reasons);
}

function renderCatalog(catalog) {
  if (Array.isArray(catalog.scenarios) && catalog.scenarios.length) scenarios = catalog.scenarios;
  const selected = $('attack-type').value;
  $('attack-type').replaceChildren(...scenarios.map((scenario) => { const option = element('option', '', scenario.name); option.value = scenario.id; return option; }));
  if (scenarios.some((scenario) => scenario.id === selected)) $('attack-type').value = selected;
  if (Array.isArray(catalog.signals) && catalog.signals.length) {
    const target = $('attack-target').value;
    $('attack-target').replaceChildren(...catalog.signals.map((signal) => { const option = element('option', '', `${hex(signal.id)} · ${signal.name}`); option.value = String(signal.id); return option; }));
    if (catalog.signals.some((signal) => String(signal.id) === target)) $('attack-target').value = target;
  }
  updateScenario();
  updateSignalSelection();
}

function updateSignalSelection() {
  const target = $('attack-target');
  for (const point of document.querySelectorAll('[data-signal]')) {
    point.setAttribute('aria-pressed', String(point.dataset.signal === target.value));
  }
  text('selected-signal', `TARGET / ${target.selectedOptions[0]?.textContent || 'Unavailable'}`);
}
function updateScenario() {
  const scenario = scenarios.find(entry => entry.id === $('attack-type').value);
  const level = Number($('attack-intensity').value);
  const strength = scenario?.intensities?.find(entry => entry.level === level);
  text('scenario-description', scenario?.description || '');
  text('intensity-level', `${strength?.label || $('attack-intensity').selectedOptions[0].textContent} · level ${level}/5`);
  text('intensity-effect', strength?.description || 'Loading the server’s intensity profile…');
  $('intensity-preview').dataset.level = String(level);
}

async function command(action, options = {}, successMessage) {
  if (pendingControl) return;
  pendingControl = true;
  updateControls();
  try {
    const result = await api('/api/control', { action, ...options });
    if (action === 'reset') { settingsDirty = false; $('settings-note').hidden = true; selectedFrame = null; holdFrames(false); $('frame-detail').hidden = true; lastEventSignature = ''; lastFrameSignature = ''; }
    renderSnapshot(result);
    if (successMessage) notify(successMessage);
  } catch (error) { notify(error.message, true); }
  finally { pendingControl = false; updateControls(); }
}

function readSeed() {
  const value = $('seed').value.trim();
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 4294967295) throw new Error('Enter a whole-number seed between 0 and 4,294,967,295.');
  return parsed;
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = element('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function renderValidation(result) {
  validationResult = result;
  $('validation-empty').hidden = true;
  $('validation-results').hidden = false;
  text('validation-summary-title', `${result.summary.passed} of ${result.summary.total} scenarios passed`);
  const created = new Date(result.createdAt);
  text('validation-provenance', `Seed ${result.seed} · Synthetic evaluation · ${Number.isNaN(created.getTime()) ? result.createdAt : created.toLocaleString()} (host time)`);
  const rows = [], details = [];
  for (const test of result.cases || []) {
    const row = element('tr');
    const outcome = element('td');
    outcome.append(element('span', test.passed ? 'result-pass' : 'result-fail', test.passed ? '✓ PASS' : '× FAIL'));
    row.append(element('td', '', test.name), outcome, element('td', '', percent(test.metrics?.precision)), element('td', '', percent(test.metrics?.recall)), element('td', '', `${count(test.metrics?.fp)} · ${percent(test.metrics?.falsePositiveRate)}`), element('td', '', percent(test.baseline?.recall)));
    rows.push(row);
    const detail = element('details', 'case-detail');
    if (!test.passed) detail.open = true;
    detail.append(element('summary', '', `${test.passed ? 'PASS' : 'FAIL'} · ${test.name}`));
    const checks = element('ul', 'case-checks');
    for (const check of test.checks || []) {
      const item = element('li');
      const copy = element('div');
      copy.append(element('strong', '', check.name), element('p', '', check.detail));
      item.append(element('span', check.passed ? 'result-pass' : 'result-fail', check.passed ? '✓' : '×'), copy);
      checks.append(item);
    }
    detail.append(checks);
    detail.append(element('p', 'case-note', `Gateway: TP ${count(test.metrics?.tp)} / FP ${count(test.metrics?.fp)} / TN ${count(test.metrics?.tn)} / FN ${count(test.metrics?.fn)}. ID whitelist: TP ${count(test.baseline?.tp)} / FP ${count(test.baseline?.fp)} / TN ${count(test.baseline?.tn)} / FN ${count(test.baseline?.fn)}.`));
    for (const note of Array.isArray(test.notes) ? test.notes : test.notes ? [test.notes] : []) detail.append(element('p', 'case-note', note));
    details.push(detail);
  }
  $('validation-body').replaceChildren(...rows);
  $('validation-case-details').replaceChildren(...details);
  $('validation-limitations').replaceChildren(...(result.limitations || []).map((limitation) => element('li', '', limitation)));
}

async function runValidation() {
  if (validating) return;
  let seed;
  try { seed = readSeed(); } catch (error) { notify(error.message, true); return; }
  validating = true;
  updateControls();
  $('validation-progress').hidden = false;
  $('validation-results').hidden = true;
  $('validation-empty').hidden = true;
  $('run-validation').lastElementChild.textContent = 'Running validation…';
  try {
    const result = await api('/api/validation', { seed });
    renderValidation(result);
    notify(`Validation complete: ${result.summary.passed} of ${result.summary.total} scenarios passed.`, result.summary.passed < result.summary.total);
  } catch (error) {
    notify(`Validation failed: ${error.message}`, true);
    $('validation-results').hidden = !validationResult;
    $('validation-empty').hidden = Boolean(validationResult);
  } finally {
    validating = false;
    $('validation-progress').hidden = true;
    $('run-validation').lastElementChild.textContent = 'Run validation suite';
    updateControls();
  }
}

function restoreValidationStatus(result) {
  if (result.report) renderValidation(result.report);
  if (!result.running) return;
  validating = true;
  $('validation-progress').hidden = false;
  $('validation-results').hidden = true;
  $('validation-empty').hidden = true;
  $('run-validation').lastElementChild.textContent = 'Running validation…';
  updateControls();
  const poll = async () => {
    try {
      const status = await api('/api/validation');
      if (status.running) { validationStatusTimer = setTimeout(poll, 1500); return; }
      validating = false;
      $('validation-progress').hidden = true;
      $('run-validation').lastElementChild.textContent = 'Run validation suite';
      if (status.report) renderValidation(status.report);
      else {
        $('validation-empty').hidden = false;
        notify('The earlier validation run ended without a report. Run the suite again.', true);
      }
      updateControls();
    } catch { validationStatusTimer = setTimeout(poll, 3000); }
  };
  validationStatusTimer = setTimeout(poll, 1500);
}

async function importTrace(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { notify('This trace exceeds 2 MB. Choose a smaller trace with at most 20,000 frames.', true); event.target.value = ''; return; }
  importing = true;
  updateControls();
  // Change only the label text node so the decorative arrow stays aria-hidden.
  $('import-trigger').firstChild.textContent = 'Importing… ';
  try {
    const source = await file.text();
    const result = await api('/api/import', { format: $('import-format').value, text: source });
    settingsDirty = false;
    $('settings-note').hidden = true;
    selectedFrame = null;
    holdFrames(false);
    $('frame-detail').hidden = true;
    lastFrameSignature = '';
    lastEventSignature = '';
    $('frame-search').value = '';
    $('decision-filter').value = 'all';
    $('label-filter').value = 'all';
    renderSnapshot(result.snapshot);
    const warnings = result.summary?.warnings;
    const warningText = Array.isArray(warnings) && warnings.length ? ` ${warnings.join(' ')}` : '';
    notify(`Imported ${file.name}. The replay is now the current paused session.${warningText}`);
  } catch (error) { notify(`Import failed: ${error.message}`, true); }
  finally {
    importing = false;
    event.target.value = '';
    $('import-trigger').firstChild.textContent = 'Import trace ';
    updateControls();
  }
}

async function refreshState() {
  if (pollPending) return;
  pollPending = true;
  try { renderSnapshot(await api('/api/state')); }
  catch { connectionStatus(false); }
  finally { pollPending = false; }
}

function connectStream() {
  eventSource?.close();
  if (browserRuntime) { eventSource = browserRuntime.subscribe(renderSnapshot, () => connectionStatus(false)); return; }
  if (!('EventSource' in window)) return;
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('state', (event) => {
    try { renderSnapshot(JSON.parse(event.data)); }
    catch { notify('A live update could not be read. Reconnect to refresh the simulation state.', true); }
  });
  eventSource.onerror = () => { connectionStatus(false); };
}

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.setAttribute('aria-label', viewCopy[tab.dataset.tab][0]);
  tab.addEventListener('click', () => setView(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const names = Object.keys(viewCopy), current = names.indexOf(tab.dataset.tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (current + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
    setView(names[next], true);
  });
}
window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
const tabIndicator = element('span', 'tab-indicator');
tabIndicator.setAttribute('aria-hidden', 'true');
document.querySelector('.tabs').append(tabIndicator);
document.querySelector('.tabs').dataset.indicator = 'slide';
const tabGeometry = new ResizeObserver(() => placeTabIndicator(false));
for (const node of [document.querySelector('.tabs'), ...document.querySelectorAll('[data-tab]')]) tabGeometry.observe(node);
const mobileNavigation = window.matchMedia('(max-width:560px)');
function updateNavOrientation() { document.querySelector('.tabs').setAttribute('aria-orientation', 'horizontal'); }
mobileNavigation.addEventListener('change', updateNavOrientation);
updateNavOrientation();
$('toggle-run').addEventListener('click', () => command(state?.running ? 'pause' : 'start'));
$('step').addEventListener('click', () => command('step', { milliseconds: 100 }));
$('reset').addEventListener('click', () => {
  try { command('reset', { seed: readSeed(), profile: $('profile').value }, 'Simulation reset. Run or step to begin the new session.'); }
  catch (error) { notify(error.message, true); }
});
$('reset-import').addEventListener('click', () => $('reset').click());
for (const id of ['profile', 'seed']) $(id).addEventListener('input', () => { settingsDirty = true; $('settings-note').hidden = false; });
$('speed').addEventListener('change', (event) => command('speed', { speed: Number(event.target.value) }));
$('analyst-toggle').addEventListener('change', (event) => command('analyst', { connected: event.target.checked }, event.target.checked ? 'Raspberry Pi analyst connected.' : 'Raspberry Pi analyst disconnected. Local gateway rules remain active.'));
$('clear-attacks').addEventListener('click', () => command('clear-attacks', {}, 'Active attacks cleared. Continue the model to observe the quiet interval.'));
$('recover').addEventListener('click', () => command('recover', {}, 'Recovery request submitted to the independent safety task.'));
$('attack-type').addEventListener('change', updateScenario);
$('attack-intensity').addEventListener('change', updateScenario);
$('attack-target').addEventListener('change', updateSignalSelection);
for (const point of document.querySelectorAll('[data-signal]')) {
  point.addEventListener('click', () => {
    const target = $('attack-target');
    if (![...target.options].some(option => option.value === point.dataset.signal)) return;
    target.value = point.dataset.signal;
    updateSignalSelection();
  });
}
async function injectAttack() {
  if (pendingControl || !connected) return;
  pendingControl = true;
  updateControls();
  try {
    const result = await api('/api/attack', { type: $('attack-type').value, targetId: Number($('attack-target').value), durationMs: Number($('attack-duration').value), intensity: Number($('attack-intensity').value) });
    renderSnapshot(result);
    notify(result.running ? 'Attack injected. Watch the gateway response and decision evidence.' : 'Attack scheduled. Run or step the simulation to advance it.');
  } catch (error) { notify(error.message, true); }
  finally { pendingControl = false; updateControls(); }
}

// Injection needs intent: hold for 600 ms, or press once to arm and again to confirm (keyboard and assistive tech).
function setInjectArmed(armed) {
  const button = $('inject-attack');
  clearTimeout(inject.armTimer);
  button.toggleAttribute('data-armed', armed);
  button.querySelector('.inject-label').textContent = armed ? 'Confirm injection' : 'Inject attack';
  text('inject-status', armed ? 'Press Inject attack again within 5 seconds to confirm.' : '');
  if (armed) inject.armTimer = setTimeout(() => setInjectArmed(false), INJECT_ARM_MS);
}
// Motion's primary-pointer rule: the main mouse button, or the first touch or pen contact.
const isPrimaryPointer = (event) => (event.pointerType === 'mouse' ? event.button <= 0 : event.isPrimary !== false);
function stopInjectRing() {
  clearTimeout(inject.holdTimer);
  inject.token++;
  inject.ring.forEach((animation) => animation.cancel());
  inject.ring = [];
  $('inject-attack').removeAttribute('data-holding');
}
function endInjectPress() {
  inject.pointerId = null;
  window.removeEventListener('pointerup', onInjectRelease, true);
  window.removeEventListener('pointercancel', onInjectCancel, true);
  window.removeEventListener('pointermove', onInjectMove, true);
}
function endInjectHold() { endInjectPress(); stopInjectRing(); }
function completeInjectHold() {
  inject.held = true;
  stopInjectRing();
  setInjectArmed(false);
  injectAttack();
}
function startInjectHold(event) {
  const button = event.currentTarget;
  if (!isPrimaryPointer(event) || button.disabled) return;
  endInjectHold();
  inject.held = false;
  inject.pointerId = event.pointerId;
  // As in Motion's press gesture, the end of the press is tracked on the window, so a release anywhere is seen.
  window.addEventListener('pointerup', onInjectRelease, true);
  window.addEventListener('pointercancel', onInjectCancel, true);
  window.addEventListener('pointermove', onInjectMove, true);
  button.setAttribute('data-holding', '');
  const [right, left] = button.querySelectorAll('.hold-half i');
  // Two clipped half rings rotate in turn, so progress is drawn with transforms only; linear because it is elapsed time.
  inject.ring = [
    play(right, [{ transform: 'rotate(-135deg)' }, { transform: 'rotate(45deg)', offset: 0.5 }, { transform: 'rotate(45deg)' }], { duration: INJECT_HOLD_MS, easing: 'linear', fill: 'forwards' }),
    play(left, [{ transform: 'rotate(45deg)' }, { transform: 'rotate(45deg)', offset: 0.5 }, { transform: 'rotate(225deg)' }], { duration: INJECT_HOLD_MS, easing: 'linear', fill: 'forwards' }),
  ].filter(Boolean);
  // The ring is the clock: the attack fires when it visibly closes. Reduced motion draws no ring, so a timer stands in.
  const token = inject.token;
  const closed = inject.ring.length
    ? Promise.all(inject.ring.map((animation) => animation.finished))
    : new Promise((resolve) => { inject.holdTimer = setTimeout(resolve, INJECT_HOLD_MS); });
  closed.then(() => { if (token === inject.token) completeInjectHold(); }, () => {});
}
function onInjectRelease(event) {
  if (event.pointerId !== inject.pointerId) return;
  endInjectPress();
  if (!inject.held) { stopInjectRing(); return; }
  // The release that ends a completed hold must not also arm the button; touch can deliver that click late.
  clearTimeout(inject.releaseTimer);
  inject.releaseTimer = setTimeout(() => { inject.held = false; }, 600);
}
function onInjectCancel(event) { if (event.pointerId === inject.pointerId) endInjectHold(); }
// Small drift, such as a finger on a phone, keeps the hold; moving clearly off the button abandons it.
function onInjectMove(event) {
  if (event.pointerId !== inject.pointerId || inject.held) return;
  const box = $('inject-attack').getBoundingClientRect();
  if (event.clientX < box.left - INJECT_SLOP_PX || event.clientX > box.right + INJECT_SLOP_PX || event.clientY < box.top - INJECT_SLOP_PX || event.clientY > box.bottom + INJECT_SLOP_PX) endInjectHold();
}
const injectButton = $('inject-attack');
injectButton.addEventListener('pointerdown', startInjectHold);
injectButton.addEventListener('click', (event) => { if (inject.held) { inject.held = false; event.preventDefault(); } });
injectButton.addEventListener('keydown', (event) => {
  inject.held = false;
  // A held key auto-repeats; only a fresh press may arm or confirm, as in Motion's keyboard press.
  if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  if (event.key === 'Escape') setInjectArmed(false);
});
injectButton.addEventListener('contextmenu', (event) => event.preventDefault());
injectButton.addEventListener('blur', () => setInjectArmed(false));
$('attack-form').addEventListener('change', () => setInjectArmed(false));
$('attack-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (pendingControl || !connected) return;
  if (!injectButton.hasAttribute('data-armed')) { setInjectArmed(true); return; }
  setInjectArmed(false);
  injectAttack();
});
$('dismiss-notification').addEventListener('click', () => { $('notification').hidden = true; });
$('reconnect').addEventListener('click', async () => { text('reconnect', 'Reconnecting…'); await refreshState(); connectStream(); text('reconnect', 'Reconnect'); });
for (const id of ['frame-search', 'decision-filter', 'label-filter']) $(id).addEventListener(id === 'frame-search' ? 'input' : 'change', () => renderFrames(true));
$('hold-frames').addEventListener('click', () => { holdFrames(!heldFrames); renderFrames(true); });
$('close-frame-detail').addEventListener('click', () => { selectedFrame = null; $('frame-detail').hidden = true; renderFrames(true); });
$('run-validation').addEventListener('click', runValidation);
$('download-validation').addEventListener('click', () => { if (validationResult) downloadJson(validationResult, `sentinel-validation-seed-${validationResult.seed}.json`); });
$('import-trigger').addEventListener('click', () => $('trace-file').click());
$('trace-file').addEventListener('change', importTrace);
$('guide-start').addEventListener('click', () => { setView('overview'); $('toggle-run').focus(); });
$('guide-import').addEventListener('click', () => { setView('traffic'); $('import-trigger').focus(); });
window.addEventListener('pagehide', () => { eventSource?.close(); clearTimeout(validationStatusTimer); });
setInterval(() => { if (!connected || !eventSource || eventSource.readyState !== 1) refreshState(); }, 2500);

if (browserMode) {
  document.querySelector('.edition small').textContent = 'BROWSER EDITION';
  const note = element('p', 'settings-note', 'Private to this tab. Traces stay on your device. Export your results before reloading or closing.');
  document.querySelector('.control-bar').after(note);
  for (const link of document.querySelectorAll('a[href^="/api/export"]')) {
    const format = new URL(link.href).searchParams.get('format');
    link.addEventListener('click', async event => {
      event.preventDefault();
      try { await browserRuntime.download(format); } catch (error) { notify(error.message, true); }
    });
  }
}

setView(location.hash.slice(1));
renderChart();
updateControls();
const initial = await Promise.allSettled([api('/api/state'), api('/api/catalog'), api('/api/validation')]);
if (initial[0].status === 'fulfilled') renderSnapshot(initial[0].value);
else connectionStatus(false);
if (initial[1].status === 'fulfilled') renderCatalog(initial[1].value);
else if (state?.signals) renderCatalog({ signals: state.signals });
if (initial[2].status === 'fulfilled') restoreValidationStatus(initial[2].value);
connectStream();

