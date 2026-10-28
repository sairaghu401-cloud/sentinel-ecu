/* ==========================================================================
   Sentinel ECU — Signal Resolve (approved R2 · production presentation)
   Vanilla JS. All traffic, verdicts, reasons and counters come from the
   project's real engine via the existing browser/session and local HTTP APIs. This file only visualises that output:
   - continuous sections + one live stage following the reader
   - "Signal Resolve" intro field (decorative canvas)
   - sampled packet animation: each moving packet is one real recorded frame
   - gateway decision callout, rejection lane, drop bins, stage counters
   - evidence list ↔ recorded journey highlight (never pauses the model)
   ========================================================================== */
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const NS = 'http://www.w3.org/2000/svg';
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = (name) => parseFloat(css(name)) || 0;
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const n = (v) => fmt.format(Number(v) || 0);
  const hex = (id) => `0x${Number(id).toString(16).toUpperCase().padStart(3, '0')}`;
  const clock = (t) => { const v = Math.max(0, Math.floor(Number(t) || 0)); return `${String(Math.floor(v / 60000)).padStart(2, '0')}:${String(Math.floor(v / 1000) % 60).padStart(2, '0')}.${String(v % 1000).padStart(3, '0')}`; };
  const esc = (s) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const ICON = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

  /* Mapping from the engine's verbatim reason strings to its RULES names (src/simulation.js). */
  const RULE_OF = {
    'Identifier is not on the gateway allowlist': 'Identifier allowlist',
    'Signal schema requires DLC 8': 'Schema length',
    'Per-identifier rate exceeds the 100 ms budget': 'Rate and queue protection',
    'Inter-arrival time is shorter than the configured period': 'Minimum inter-arrival time',
    'Payload violates physical bounds or reserved fields': 'Physical range and slew',
    'Payload changes faster than the configured slew limit': 'Physical range and slew',
    'Rolling counter is stale or outside the freshness window': 'Rolling counter freshness',
    'Analyst hold: sustained deviation from learned normal traffic': 'Analyst hold · enforced by the gateway',
    'Ingress queue capacity exceeded': 'Bounded CAN A queue · availability loss, not a detection',
    'Egress queue capacity exceeded': 'Bounded CAN B queue · availability loss, not a detection',
    'Gateway checks passed': 'All six rule checks passed',
  };
  const SIGNAL_NAME = { 288: 'Brake', 304: 'Steering', 512: 'Powertrain', 768: 'Battery', 1024: 'Body', 1280: 'Infotainment' };
  const sigName = (id) => SIGNAL_NAME[id] || 'Unknown ID';
  const STEP_NOTES = {
    1: 'Live engine preview (seed 42 · protocol fuzzing, Low). Frames travel left → right. Solid = baseline traffic; dithered orange = injected by the generator.',
    2: 'Preview: CAN flooding, Moderate, on 0x400 Body. Forwarded frames turn teal and continue to the ECU; blocked frames stop at the gateway and drop into the rejection lane.',
    3: 'Preview: payload drift, Low, on 0x300 Battery. Dashed lines are observation, not barriers — copies go up to the analyst, evidence comes back, the gateway enforces any hold.',
    4: 'Preview: payload manipulation, Maximum, on 0x120 Brake. The gateway can only request; the independent safety task latches the mode and disables the motor.',
  };
  const PICTS = {
    spoofing: '<path class="pict-base" d="M0 9h56"/><rect class="pict-on" x="3" y="5" width="12" height="8"/><rect class="pict-inj" x="22" y="5" width="12" height="8"/><rect class="pict-on" x="41" y="5" width="12" height="8"/>',
    replay: '<path class="pict-base" d="M0 9h56"/><rect class="pict-on" x="3" y="5" width="10" height="8"/><path d="M10 4V1h30v3" fill="none" stroke="#E8590C" stroke-width="1.5"/><rect class="pict-inj" x="35" y="5" width="10" height="8"/>',
    flooding: '<path class="pict-base" d="M0 9h56"/>' + Array.from({ length: 11 }, (_, i) => `<rect class="pict-inj" x="${2 + i * 5}" y="5" width="3" height="8"/>`).join(''),
    fuzzing: '<path class="pict-base" d="M0 9h56"/>' + [6, 12, 4, 14, 8, 3, 11].map((h, i) => `<rect class="pict-inj" x="${3 + i * 8}" y="${9 - h / 2}" width="4" height="${h}"/>`).join(''),
    payload: '<path class="pict-base" d="M0 9h56"/><rect class="pict-on" x="8" y="4" width="40" height="10"/><rect class="pict-inj" x="28" y="4" width="10" height="10"/>',
    stealth: '<path class="pict-base" d="M0 12h56"/><path d="M2 12C20 12 34 11 54 4" fill="none" stroke="#E8590C" stroke-width="1.6" stroke-dasharray="2 2"/><circle class="pict-inj" cx="54" cy="4" r="2.2"/>',
  };

  /* ---------------- state ---------------- */
  const state = {
    view: 'intro', step: 1,
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    live: null, frames: [], catalog: null,
    attack: { type: 'spoofing', targetId: 288, durationMs: 5000, intensity: 2 },
    confirming: false,
    selected: null, filters: { FORWARD: true, BLOCK: true, DROP: true },
    sideTab: 'attack', mtab: 'monitor',
    stageVisible: true, pageVisible: !document.hidden,
    history: [], lastSession: null,
  };
  const stage = $('#stage'), net = $('#net'), packetsG = $('#packets'), hlG = $('#hl'), overlay = $('#overlay'), canvas = $('canvas.field', stage);
  const body = document.body;

  /* ==========================================================================
     Engine connection (module worker; main-thread fallback)
     ========================================================================== */
  let engine = null; let ackSeq = 0; const pending = new Map();
  function onEngine(msg) {
    if (msg.type === 'connection') { connection(msg); return; }
    if (msg.type === 'catalog') { state.catalog = msg; buildAttackForm(); return; }
    if (msg.type === 'ack') { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.ok ? p.resolve() : p.reject(new Error(msg.error)); } return; }
    if (msg.type === 'live') return onLive(msg);
    if (msg.type === 'frames') return onFrames(msg);
  }
  function send(msg) { if (!engine) return Promise.reject(new Error('Engine not ready')); const id = ++ackSeq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); engine.postMessage({ ...msg, id }); }); }
  const cmd = async (action, extra = {}) => {
    commandPending = true; lockControls();
    try { const result = await send({ type: 'cmd', action, ...extra }); delete $('#session-notice').dataset.userError; if (online && !imported) $('#session-notice').hidden = true; return result; }
    catch (e) { showError(e.message); throw e; }
    finally { commandPending = false; lockControls(); }
  };
  async function startEngine() {
    const { SessionAdapter } = await import('./session-adapter.js');
    engine = new SessionAdapter(onEngine);
    tellView();
  }
  function tellView() { if (engine) send({ type: 'view', view: state.view, step: state.step }).catch(e => showError(e.message)); }

  /* ==========================================================================
     Reduced motion
     ========================================================================== */
  function applyReduced() {
    document.documentElement.classList.toggle('reduced', state.reduced);
    $$('[data-motion-toggle]').forEach(b => { b.setAttribute('aria-pressed', String(state.reduced)); b.querySelector('span').textContent = state.reduced ? 'Reduced motion · on' : 'Reduce motion'; });
    clearPackets(); lastReduced = 0;
    drawField(1);
    if (state.selected) drawSelection(state.selected, false);
  }
  $$('[data-motion-toggle]').forEach(b => b.addEventListener('click', () => { state.reduced = !state.reduced; applyReduced(); }));
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', e => { state.reduced = e.matches; applyReduced(); });

  /* ==========================================================================
     Continuous scroll sections and the shared live stage
     ========================================================================== */
  const VIEWS = ['intro', 'architecture', 'workbench'];
  const slotFor = (view) => $(`.stage-slot[data-slot="${view}"]`);
  function setView(view) {
    if (!VIEWS.includes(view)) view = 'intro';
    if (state.view === view && stage.parentElement === slotFor(view)) return;
    state.view = view;
    body.dataset.view = view;
    body.dataset.theme = view === 'intro' ? 'night' : 'light';
    $('#topbar').dataset.tone = view === 'intro' ? 'night' : 'light';
    $$('.view').forEach(v => v.classList.toggle('is-active', v.id === view));
    $$('.topnav a').forEach(a => {
      if (a.getAttribute('href') === '#' + view) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    });
    slotFor(view).appendChild(stage);
    $$('.stage-slot').forEach(slot => slot.classList.toggle('has-live-stage', slot.contains(stage)));
    clearPackets(); clearSelection(); resetStageMemory();
    net.removeAttribute('data-focus');
    if (view === 'architecture') setStep(state.step, true);
    tellView(); placeCallout(); resizeField(); layoutOverlay();
  }
  function routeName() { const h = location.hash.slice(1); return h === 'overview' ? 'workbench' : h === 'system' ? 'architecture' : h || (location.pathname.startsWith('/simulator') ? 'workbench' : 'intro'); }
  function navigateTo(view, instant = false) {
    if (!VIEWS.includes(view)) view = 'intro';
    $('#' + view).scrollIntoView({ block: 'start', behavior: instant || state.reduced ? 'instant' : 'smooth' });
    if (instant) setView(view);
  }
  function routeFromHash() { navigateTo(routeName()); }
  window.addEventListener('hashchange', routeFromHash);
  let scrollPending = false;
  function followScroll() {
    scrollPending = false;
    const line = Math.min(innerHeight * .4, 300);
    const view = VIEWS.find(id => { const r = $('#' + id).getBoundingClientRect(); return r.top <= line && r.bottom > line; }) || 'intro';
    if (view !== state.view) {
      setView(view);
      history.replaceState(null, '', '#' + view);
    }
  }
  window.addEventListener('scroll', () => { if (!scrollPending) { scrollPending = true; requestAnimationFrame(followScroll); } }, { passive: true });
  function makeStaticStages() {
    // Inactive sections keep a lightweight, non-interactive schematic while the
    // single live renderer follows the reader. No duplicate engines or IDs.
    VIEWS.forEach(view => {
      const shell = document.createElement('div'); shell.className = 'stage static-stage'; shell.setAttribute('aria-hidden', 'true');
      const copy = net.cloneNode(true); const ids = new Map();
      $$('[id]', copy).forEach(el => { ids.set(el.id, view + '-preview-' + el.id); el.id = ids.get(el.id); });
      copy.removeAttribute('id');
      $$('*', copy).forEach(el => [...el.attributes].forEach(attr => {
        let value = attr.value;
        ids.forEach((next, old) => { value = value.replaceAll('url(#' + old + ')', 'url(#' + next + ')'); if (value === '#' + old) value = '#' + next; });
        if (value !== attr.value) el.setAttribute(attr.name, value);
      }));
      shell.appendChild(copy); slotFor(view).appendChild(shell);
    });
  }

  /* ==========================================================================
     Architecture walkthrough (each step runs a seeded engine preview)
     ========================================================================== */
  function setStep(n, silent) {
    state.step = Math.max(1, Math.min(4, n));
    net.dataset.focus = String(state.step);
    $$('.step').forEach(li => { const on = Number(li.dataset.step) === state.step; li.classList.toggle('is-active', on); li.querySelector('button').setAttribute('aria-expanded', String(on)); });
    $('#arch-annot').innerHTML = `<b>0${state.step}</b><span>${STEP_NOTES[state.step]}</span>`;
    $('[data-step-prev]').disabled = state.step === 1;
    $('[data-step-next]').disabled = state.step === 4;
    if (!silent) { clearPackets(); resetStageMemory(); tellView(); }
  }
  $$('.step > button').forEach(b => b.addEventListener('click', () => setStep(Number(b.parentElement.dataset.step))));
  $('[data-step-prev]').addEventListener('click', () => setStep(state.step - 1));
  $('[data-step-next]').addEventListener('click', () => setStep(state.step + 1));

  /* ==========================================================================
     Signal Resolve field (canvas, decorative)
     ========================================================================== */
  const VB = { x: 0, y: 0, w: 1000, h: 600 };
  const BODY = new Path2D($('#body-path').getAttribute('d'));
  const CABIN = new Path2D('M330 176L670 174C740 178 770 240 772 310C770 380 740 442 670 446L330 444C292 440 278 380 278 310C278 240 292 180 330 176Z');
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + .5) / 16);
  const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let marks = null;
  function buildMarks() {
    const probe = document.createElement('canvas').getContext('2d');
    const out = []; const G = 8; const r0 = mulberry(9001);
    for (let y = 4; y < VB.h; y += G) for (let x = 4; x < VB.w; x += G) {
      const th = BAYER[(((y / G) | 0) % 4) * 4 + (((x / G) | 0) % 4)];
      const inside = probe.isPointInPath(BODY, x, y);
      let v = 0.07;
      if (inside) { v = 0.18 + 0.45 * (1 - Math.min(1, Math.abs(y - 300) / 170)); if (probe.isPointInPath(CABIN, x, y)) v *= 0.45; }
      const final = v > th, initial = r0() < 0.14;
      if (!final && !initial) continue;
      out.push({ x, y, inside, final, initial, jx: (r0() - .5) * 10, jy: (r0() - .5) * 10, d: (x / 1000) * 0.38 + r0() * 0.22, accent: inside && Math.abs(y - 300) < 6 && r0() < 0.35 });
    }
    marks = out;
  }
  let fieldScale = 1, dpr = 1;
  function resizeField() {
    const r = stage.getBoundingClientRect(); if (!r.width) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    fieldScale = Math.min(r.width / VB.w, r.height / VB.h);
    drawField(1);
  }
  const ease = t => 1 - Math.pow(1 - t, 3);
  function drawField(p) {
    if (!marks) buildMarks();
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.translate((w - VB.w * fieldScale) / 2, (h - VB.h * fieldScale) / 2); ctx.scale(fieldScale, fieldScale);
    const night = body.dataset.theme === 'night', bench = state.view === 'workbench';
    const markCol = night ? '#77716A' : '#CFC8BA', accentCol = night ? '#F26B21' : '#E8590C';
    const inA = night ? 0.8 : bench ? 0.32 : 0.42, outA = night ? 0.45 : bench ? 0.35 : 0.5, startA = night ? 0.45 : 0.3;
    for (const m of marks) {
      const k = ease(Math.max(0, Math.min(1, (p - m.d) / 0.4)));
      const a0 = m.initial ? startA : 0, a1 = m.final ? (m.inside ? inA : outA) : 0;
      const a = a0 + (a1 - a0) * k; if (a < 0.02) continue;
      const x = m.x + m.jx * (1 - k), y = m.y + m.jy * (1 - k);
      ctx.globalAlpha = a; ctx.fillStyle = (m.accent && night && k > 0.6) ? accentCol : markCol;
      if (m.inside && Math.abs(m.y - 300) < 6) ctx.fillRect(x - 3, y - 1, 6, 2); else ctx.fillRect(x - 1.1, y - 1.1, 2.2, 2.2);
    }
    ctx.globalAlpha = 1;
  }
  function playIntro() {
    const display = $('.display');
    if (state.reduced) { drawField(1); return; }
    display.classList.add('is-resolving');
    const T = ms('--t-intro'); const t0 = performance.now();
    const outline = $('#body-path'); const len = outline.getTotalLength();
    const structure = $$('.node, .bus, .bus-lane, .obs, .lane, .drop-link, .bin, .tray, .req-path, .latch-path, .queue, .net text');
    structure.forEach(el => el.style.opacity = 0);
    (function frame(now) { const p = Math.min(1, (now - t0) / (T * 0.78)); drawField(p); if (p < 1 && state.view === 'intro') requestAnimationFrame(frame); else drawField(1); })(t0);
    outline.animate([{ strokeDasharray: len, strokeDashoffset: len }, { strokeDasharray: len, strokeDashoffset: 0 }], { duration: 900, delay: T * 0.42, easing: css('--ease-out'), fill: 'backwards' });
    $$('#vehicle path:not(#body-path), #vehicle rect').forEach(el => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: T * 0.62, fill: 'backwards' }));
    structure.forEach((el, i) => { el.style.opacity = ''; el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, delay: T * 0.7 + (i % 10) * 40, easing: css('--ease-out'), fill: 'backwards' }); });
    setTimeout(() => display.classList.remove('is-resolving'), 1300);
  }

  /* ==========================================================================
     Overlay: crisp HTML text positioned from diagram coordinates
     ========================================================================== */
  function vb(x, y) { const r = stage.getBoundingClientRect(); const s = Math.min(r.width / VB.w, r.height / VB.h); return { x: (r.width - VB.w * s) / 2 + x * s, y: (r.height - VB.h * s) / 2 + y * s, s }; }
  const ov = {};
  function makeOverlay() {
    overlay.innerHTML = `
      <div class="ovl callout is-empty" data-ov="callout" role="status" aria-live="polite"></div>
      <div class="ovl ctr" data-ov="ctrA"></div>
      <div class="ovl ctr fwd" data-ov="ctrB"></div>
      <div class="ovl box-ovl bin-ovl" data-ov="binIn"></div>
      <div class="ovl box-ovl tray-ovl" data-ov="tray"></div>
      <div class="ovl box-ovl bin-ovl" data-ov="binEg"></div>
      <div class="ovl arrive" data-ov="arrive" hidden></div>`;
    $$('[data-ov]', overlay).forEach(el => ov[el.dataset.ov] = el);
    ov.binIn.innerHTML = `<span class="t">${ICON('i-drop')}Dropped · CAN A ingress</span><span class="n" data-v>0</span><span class="note">Queue full · not a detection</span>`;
    ov.tray.innerHTML = `<span class="t">${ICON('i-block')}Blocked by gateway</span><span class="n" data-v>0</span><span class="note">Explanatory lane · not a CAN bus</span>`;
    ov.binEg.innerHTML = `<span class="t">${ICON('i-drop')}Dropped · CAN B egress</span><span class="n" data-v>0</span><span class="note">Queue full · not a detection</span>`;
    placeCallout();
  }
  function placeBox(el, x, y, w, h) { const p = vb(x, y); el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.width = w + 'px'; if (h != null) el.style.height = h + 'px'; el.style.transformOrigin = 'top left'; el.style.transform = `scale(${p.s})`; }
  function layoutOverlay() {
    if (!ov.callout) return;
    if (ov.callout.parentElement === overlay) placeBox(ov.callout, 636, 14, 354);
    let p = vb(214, 351); ov.ctrA.style.left = p.x + 'px'; ov.ctrA.style.top = p.y + 'px'; ov.ctrA.style.transform = `translateY(-50%) scale(${p.s})`; ov.ctrA.style.transformOrigin = 'left center';
    p = vb(614, 351); ov.ctrB.style.left = p.x + 'px'; ov.ctrB.style.top = p.y + 'px'; ov.ctrB.style.transform = `translateY(-50%) scale(${p.s})`; ov.ctrB.style.transformOrigin = 'left center';
    placeBox(ov.binIn, 30, 392, 240, 88); placeBox(ov.tray, 280, 392, 290, 88); placeBox(ov.binEg, 586, 392, 240, 88);
    if (ov.arrive.parentElement === overlay) { p = vb(966, 364); ov.arrive.style.left = p.x + 'px'; ov.arrive.style.top = p.y + 'px'; }
  }
  const mqMobile = matchMedia('(max-width: 1100px)');
  function placeCallout() {
    const dock = $('#callout-dock');
    if (state.view === 'workbench') {
      if (ov.callout.parentElement !== dock) { dock.appendChild(ov.callout); dock.appendChild(ov.arrive); }
      ov.callout.style.cssText = ''; ov.arrive.style.cssText = '';
    } else if (ov.callout.parentElement !== overlay) { overlay.prepend(ov.callout); overlay.appendChild(ov.arrive); layoutOverlay(); }
  }

  /* ==========================================================================
     Gateway decision callout (one representative frame, held ≥ 3 s)
     ========================================================================== */
  const HOLD_MS = 3200;
  let calloutRec = null, calloutAt = 0;
  function originHTML(rec) {
    if (rec.label === 'attack') return `<span class="origin"><i class="sw inj"></i>injected</span>`;
    if (rec.label === 'normal') return `<span class="origin"><i class="sw base"></i>baseline</span>`;
    return `<span class="origin">unlabelled</span>`;
  }
  function verdictHTML(rec) {
    const icon = rec.decision === 'FORWARD' ? 'i-forward' : rec.decision === 'BLOCK' ? 'i-block' : 'i-drop';
    const word = rec.decision === 'FORWARD' ? 'Forwarded' : rec.decision === 'BLOCK' ? 'Blocked' : 'Dropped';
    return `<span class="verdict ${rec.decision}">${ICON(icon)}${word}</span>`;
  }
  function setCallout(rec, mode) {
    calloutRec = rec; calloutAt = performance.now();
    const el = ov.callout; if (!el) return;
    el.classList.remove('is-empty'); el.classList.toggle('is-pinned', mode === 'pinned');
    stage.classList.add('has-callout');
    const more = rec.reasons.length > 1 ? ` <span class="rule">+${rec.reasons.length - 1} more failed check${rec.reasons.length > 2 ? 's' : ''} — see Inspect frame</span>` : '';
    const where = rec.decision === 'DROP' ? (rec.reasons[0].startsWith('Ingress') ? 'at CAN A ingress' : 'at gateway egress') : 'at the gateway';
    el.innerHTML = `
      <div class="c-head"><span>${mode === 'pinned' ? '<b>Pinned</b> · ' : 'Gateway decision · '}frame #${rec.seq}</span>
        ${mode === 'pinned' ? `<button type="button" data-unpin>${ICON('i-close')}Unpin</button>` : `<span class="hint">sampled · ${esc(clock(rec.timestampMs))}</span>`}</div>
      <dl>
        <dt>Incoming</dt><dd><span class="cid">${hex(rec.id)}</span> · ${esc(rec.signal === 'Unknown' ? 'unknown ID' : rec.signal)}${originHTML(rec)}</dd>
        <dt>Decision</dt><dd>${verdictHTML(rec)}<span class="where">${where}</span></dd>
        <dt>Reason</dt><dd><span class="reason">${esc(rec.reasons[0] || '—')}</span><span class="rule">${esc(RULE_OF[rec.reasons[0]] || '')}</span>${more}</dd>
      </dl>`;
    const unpin = $('[data-unpin]', el); if (unpin) unpin.addEventListener('click', () => clearSelection());
    if (mode !== 'pinned') $$('.pk.featured', packetsG).forEach(p => p.classList.remove('featured'));
  }
  function emptyCallout(text) {
    calloutRec = null; const el = ov.callout; if (!el) return;
    el.classList.add('is-empty'); el.classList.remove('is-pinned'); stage.classList.remove('has-callout');
    el.innerHTML = `<div class="c-head"><span>Gateway decision</span></div><dl><dt>Status</dt><dd>${esc(text)}</dd></dl>`;
  }


  /* ==========================================================================
     Sampled packet animation — every packet is a real recorded frame
     ========================================================================== */
  const live = new Set();
  const pool = new Map();             // seq → { rec, at, cat }
  const launched = new Set();
  let lastLaunch = 0, rotation = 0, featuredInFlight = false, directed = [], lastFeatured = null, autoFeature = true, forceFeature = false;
  const DEFAULT_ROTATION = ['fwdB', 'blkI', 'fwdB', 'fwdI', 'blkB', 'dropIn', 'fwdB', 'dropEg', 'blkI', 'fwdB'];
  let ROTATION = DEFAULT_ROTATION;
  const LAUNCH_GAP = 440, MAX_LIVE = 7;
  const X = { start: 197, inq: 199, reveal: 330, wall: 406, mid: 500, exit: 576, egq: 598, ecu: 804, y: 300, laneY: 384 };
  /* Packet labels ride in a band just above the buses and never cover node text:
     CAN A zone 192–418 (clear of the ESP32 box), CAN B zone 590–812 (clear of the ECU).
     On a roomy (desktop) stage a label may also pass over the gateway's empty interior. */
  const ZONE = { aMin: 192, aMax: 418, bMin: 590, bMax: 812 };
  const TAG = { trail: 8, lead: 28, bottom: -9 };
  const category = (r) => r.decision === 'FORWARD' ? (r.label === 'attack' ? 'fwdI' : 'fwdB') : r.decision === 'BLOCK' ? (r.label === 'attack' ? 'blkI' : 'blkB') : (r.reasons[0].startsWith('Egress') ? 'dropEg' : 'dropIn');
  const tagText = (rec) => `${hex(rec.id)} ${rec.signal === 'Unknown' ? 'unknown' : rec.signal}`;
  const ORIGIN = (rec) => rec.label === 'attack' ? 'INJECTED' : rec.label === 'normal' ? 'BASELINE' : 'UNLABELLED';

  function running() { const l = state.live; return !!(l && l.running && (state.view !== 'workbench' || online)); }
  function canAnimate() { return !state.reduced && state.pageVisible && state.stageVisible; }
  function track(a) { live.add(a); if (!running() || !state.pageVisible || !state.stageVisible) a.pause(); a.finished.catch(() => {}).finally(() => live.delete(a)); return a; }
  function setPlayback() { const go = running() && state.pageVisible && state.stageVisible; live.forEach(a => go ? a.play() : a.pause()); }
  function clearPackets() { live.forEach(a => a.cancel()); live.clear(); packetsG.innerHTML = ''; featuredInFlight = false; }

  function makePacket(rec, { ghost = false, label = false } = {}) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'pk tag-hidden' + (rec.label === 'attack' ? ' inj' : '') + (ghost ? ' ghost' : ''));
    g.innerHTML = `<line class="pk-trail" x1="-36" y1="0" x2="-14" y2="0"/><rect class="pk-ring" x="-14" y="-9" width="28" height="18" rx="3"/>
      <rect class="pk-body" x="-11" y="-6" width="22" height="12" rx="2"/>
      <g class="pk-badge" transform="translate(17,-13)"><circle r="7"/><path class="b-blk" d="M-4 4L4-4"/><path class="b-fwd" d="M-4 0H3M0-3l3 3-3 3"/><path class="b-drp" d="M0-4v6M-3 0l3 3 3-3"/></g>` +
      (label ? '<g class="pk-tag"><rect rx="3"/><text class="pk-v"></text><text class="pk-id"></text></g>' : '');
    g.style.transform = `translate(${X.start}px, ${X.y}px)`;
    packetsG.appendChild(g);
    return g;
  }

  /* Two-line packet label: line 1 = origin before the gateway, verdict after it;
     line 2 = CAN ID + signal. Measured, then fitted to the free zone. */
  function textLen(el, perChar) { let w = 0; try { w = el.getComputedTextLength(); } catch { /* not rendered */ } return w > 0 ? w : el.textContent.length * perChar; }
  function layoutTag(g, c, side) {
    const tag = $('.pk-tag', g); if (!tag) return null;
    const tv = $('.pk-v', tag), ti = $('.pk-id', tag), r = $('rect', tag);
    tv.textContent = c.v || ''; ti.textContent = c.id || '';
    tv.style.display = c.v ? '' : 'none'; ti.style.display = c.id ? '' : 'none';
    const k = (parseFloat(getComputedStyle(ti).fontSize) || 14.5) / 14.5;
    const pad = 8 * k, two = !!(c.v && c.id);
    const w = Math.max(c.v ? textLen(tv, 7.6 * k) : 0, c.id ? textLen(ti, 8.7 * k) : 0) + pad * 2;
    const h = (two ? 33 : 22) * k, left = side === 'lead' ? TAG.lead : TAG.trail - w, top = TAG.bottom - h;
    r.setAttribute('x', left); r.setAttribute('y', top); r.setAttribute('width', w); r.setAttribute('height', h);
    tv.setAttribute('x', left + pad); ti.setAttribute('x', left + pad);
    tv.setAttribute('y', two ? top + 12 * k : TAG.bottom - 6.5 * k); ti.setAttribute('y', TAG.bottom - 6.5 * k);
    return { left, right: left + w, w, k };
  }
  function chooseTag(g, cands, side, fits) {
    for (const c of cands) { const e = layoutTag(g, c, side); if (e && fits(e)) return e; }
    return null;
  }
  function cands(rec, vs, ghost) {
    const id = tagText(rec), hx = hex(rec.id), out = [];
    if (ghost) out.push({ v: `#${rec.seq} · ${vs[0]}`, id });
    vs.forEach(v => out.push({ v, id }));
    out.push({ v: vs[vs.length - 1], id: hx }, { id: hx });
    return out;
  }
  const showTag = (g, on) => { g.classList.toggle('tag-hidden', !on); return on; };
  const hideTag = (g) => g.classList.add('tag-hidden');
  const roomy = (g) => { const t = $('.pk-id', g); return !!t && (parseFloat(getComputedStyle(t).fontSize) || 14.5) <= 17; };

  function seg(g, from, to, dur, easing = 'linear', fade) {
    const kf = [{ transform: `translate(${from[0]}px, ${from[1]}px)`, opacity: fade === 'in' ? 0 : 1 }, { transform: `translate(${to[0]}px, ${to[1]}px)`, opacity: fade === 'out' ? 0 : 1 }];
    return track(g.animate(kf, { duration: Math.max(1, dur), easing, fill: 'forwards' })).finished;
  }
  const hold = (g, at, dur) => seg(g, at, at, dur);

  async function journey(rec, { ghost = false, feature = false } = {}) {
    const intro = state.view === 'intro';
    const labelled = (feature || ghost) && !intro;
    const g = makePacket(rec, { ghost, label: labelled });
    if (feature) g.classList.add('featured');
    const decide = () => { if (feature) { featuredInFlight = false; lastFeatured = rec.decision; if (!state.selected) setCallout(rec, 'sampled'); g.classList.add('featured'); } };
    const cat = category(rec);
    const slow = feature || ghost;            // explained frames linger at their decision point
    const tag = (vs, side, fits) => labelled ? showTag(g, !!chooseTag(g, cands(rec, vs, ghost), side, fits)) : false;
    const settle = async (x, bin) => {        // stop, then move into the lane / bin below (fade in place on the intro)
      hideTag(g);
      if (intro) { await seg(g, [x, X.y], [x, X.y], 260, 'linear', 'out'); return finish(g, ghost); }
      await seg(g, [x, X.y], [x, X.laneY], bin === 'tray' ? 520 : 560, css(bin === 'tray' ? '--ease-inout' : '--ease-in'));
      if (ghost) receipt(rec); else await seg(g, [x, X.laneY], [x, X.laneY + 12], 240, 'linear', 'out');
      return finish(g, ghost);
    };
    try {
      if (cat === 'dropIn') {
        await seg(g, [X.start - 14, X.y], [X.inq, X.y], 320, 'linear', 'in');
        g.classList.add('drp'); tag(['↓ DROPPED · QUEUE FULL', '↓ DROPPED'], 'lead', e => X.inq + e.right <= ZONE.aMax);
        decide();
        await hold(g, [X.inq, X.y], slow ? 1300 : 420);
        return await settle(X.inq, 'binIn');
      }
      /* CAN A: the label (origin + CAN ID) appears once it clears the ESP32 box */
      let reveal = X.reveal, ready = false;
      if (labelled) {
        const e = chooseTag(g, cands(rec, [ORIGIN(rec)], ghost), 'trail', e => X.wall + e.left >= ZONE.aMin);
        if (e) { ready = true; reveal = Math.min(X.wall - 20, Math.max(X.reveal, ZONE.aMin - e.left)); }
      }
      const vA = (X.wall - X.reveal) / 590;   // slower approach to the gateway
      await seg(g, [X.start - 14, X.y], [X.reveal, X.y], 560, 'linear', 'in');
      if (reveal > X.reveal) await seg(g, [X.reveal, X.y], [reveal, X.y], (reveal - X.reveal) / vA);
      if (ready) showTag(g, true);
      await seg(g, [reveal, X.y], [X.wall, X.y], (X.wall - reveal) / vA);
      if (cat === 'blkI' || cat === 'blkB') {
        g.classList.add('blk'); tag(['⊘ BLOCKED'], 'trail', e => X.wall + e.left >= ZONE.aMin);
        decide();
        await hold(g, [X.wall, X.y], slow ? 1300 : 650);
        return await settle(X.wall, 'tray');
      }
      if (!roomy(g)) hideTag(g);             // small stage: no label inside the gateway
      await seg(g, [X.wall, X.y], [X.mid, X.y], 380);
      decide();
      if (cat === 'dropEg') {
        hideTag(g);
        await hold(g, [X.mid, X.y], 360);
        await seg(g, [X.mid, X.y], [X.egq, X.y], 360);
        g.classList.add('drp'); tag(['↓ DROPPED · QUEUE FULL', '↓ DROPPED'], 'lead', e => X.egq + e.right <= ZONE.bMax);
        await hold(g, [X.egq, X.y], slow ? 1300 : 380);
        return await settle(X.egq, 'binEg');
      }
      g.classList.add('fwd');
      let shown = labelled && roomy(g) && tag(['→ FORWARDED'], 'trail', e => X.mid + e.left >= ZONE.aMin);
      if (labelled && !shown) hideTag(g);
      await hold(g, [X.mid, X.y], 360);
      await seg(g, [X.mid, X.y], [X.exit, X.y], 300);
      /* CAN B: on a small stage the forwarded label appears once it clears the gateway */
      let revealB = X.exit;
      if (labelled && !shown) {
        const e = chooseTag(g, cands(rec, ['→ FORWARDED'], ghost), 'trail', e => X.ecu + e.left >= ZONE.bMin);
        if (e) { shown = true; revealB = Math.min(X.ecu - 10, Math.max(X.exit, ZONE.bMin - e.left)); }
      }
      const vB = (X.ecu - X.exit) / 1050;
      if (revealB > X.exit) await seg(g, [X.exit, X.y], [revealB, X.y], (revealB - X.exit) / vB);
      if (shown) showTag(g, true);
      await seg(g, [revealB, X.y], [X.ecu, X.y], (X.ecu - revealB) / vB);
      if (ghost) receipt(rec); else arrive(rec, feature);
      if (!ghost) await seg(g, [X.ecu, X.y], [X.ecu + 8, X.y], 320, 'linear', 'out');
      return finish(g, ghost);
    } catch (err) { if (!err || err.name !== 'AbortError') console.warn('journey', err); g.remove(); if (feature) featuredInFlight = false; }
  }
  function finish(g, ghost) { if (!ghost) g.remove(); }

  /* Reduced motion: a packet drawn still at the point where its recorded journey ended. */
  function stillPacket(rec, { ghost = false } = {}) {
    $$(ghost ? '.pk.ghost' : '.pk.still:not(.ghost)', packetsG).forEach(p => p.remove());
    const labelled = state.view !== 'intro';
    const g = makePacket(rec, { ghost, label: labelled });
    const cat = category(rec), blk = cat === 'blkI' || cat === 'blkB', drp = cat === 'dropIn' || cat === 'dropEg';
    const at = cat === 'dropIn' ? X.inq : cat === 'dropEg' ? X.egq : blk ? X.wall : X.ecu;
    g.classList.add('still', drp ? 'drp' : blk ? 'blk' : 'fwd');
    g.style.transform = `translate(${at}px, ${X.y}px)`;
    if (labelled) {
      const e = drp ? chooseTag(g, cands(rec, ['↓ DROPPED · QUEUE FULL', '↓ DROPPED'], ghost), 'lead', e => at + e.right <= (cat === 'dropIn' ? ZONE.aMax : ZONE.bMax))
        : blk ? chooseTag(g, cands(rec, ['⊘ BLOCKED'], ghost), 'trail', e => at + e.left >= ZONE.aMin)
        : chooseTag(g, cands(rec, ['→ FORWARDED'], ghost), 'trail', e => at + e.left >= ZONE.bMin);
      showTag(g, !!e);
    }
    return g;
  }

  let arriveTimer = null, arriveHeld = 0;
  function arrive(rec, featured = false) {
    const el = ov.arrive; if (!el || state.selected) return;   // while pinned, the receipt line belongs to the pinned frame
    if (!featured && performance.now() < arriveHeld) return;  // keep the explained frame's receipt readable
    arriveHeld = featured ? performance.now() + 2200 : 0;
    el.hidden = false; el.className = 'ovl arrive'; el.innerHTML = `${ICON('i-ecu')}Received by ECU · ${esc(tagText(rec))}`;
    const ecu = $('.ecu .box', net);
    if (!state.reduced) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: 'forwards' }); const ink = getComputedStyle(ecu).stroke; ecu.animate([{ stroke: css('--ok'), strokeWidth: 3 }, { stroke: ink, strokeWidth: 1.5 }], { duration: 700, easing: 'ease-out' }); }
    clearTimeout(arriveTimer); if (!state.reduced) arriveTimer = setTimeout(() => { el.hidden = true; }, featured ? 2400 : 1400);
  }
  /* The pinned frame's recorded outcome, stated where delivery would happen. */
  function receipt(rec) {
    const el = ov.arrive; if (!el) return;
    clearTimeout(arriveTimer);
    if (rec.decision === 'FORWARD') { el.className = 'ovl arrive'; el.innerHTML = `${ICON('i-ecu')}Received by ECU · #${rec.seq} ${esc(tagText(rec))}`; }
    else {
      const where = rec.decision === 'BLOCK' ? 'blocked at the gateway' : rec.reasons[0].startsWith('Ingress') ? 'dropped at CAN A ingress' : 'dropped at CAN B egress';
      el.className = 'ovl arrive ' + (rec.decision === 'BLOCK' ? 'blk' : 'drp');
      el.innerHTML = `${ICON(rec.decision === 'BLOCK' ? 'i-block' : 'i-drop')}Not received by ECU · #${rec.seq} ${where}`;
    }
    el.hidden = false;
  }

  /* Frames that reached the lane or a bin are listed in Evidence (Blocked / Dropped filters). */
  function resetStageMemory() { pool.clear(); launched.clear(); calloutRec = null; lastFeatured = null; if (ov.callout) emptyCallout('Waiting for frames…'); if (ov.arrive) ov.arrive.hidden = true; }

  function addSamples(samples) {
    const now = performance.now();
    for (const rec of samples) if (!pool.has(rec.seq) && !launched.has(rec.seq)) pool.set(rec.seq, { rec, at: now, cat: category(rec) });
    for (const [seq, e] of pool) if (now - e.at > 3000) pool.delete(seq);
    if (launched.size > 600) { const keep = [...launched].slice(-300); launched.clear(); keep.forEach(s => launched.add(s)); }
  }
  function takeWhere(pred) {
    let best = null;
    for (const e of pool.values()) if (pred(e.rec, e.cat) && (!best || e.rec.seq > best.rec.seq)) best = e;
    if (best) { pool.delete(best.rec.seq); launched.add(best.rec.seq); }
    return best && best.rec;
  }
  const takeFrom = (cat) => takeWhere((r, c) => c === cat);
  function launcher() {
    const now = performance.now();
    if (!state.live) return;
    if (state.reduced) return reducedTick(now);
    if (!canAnimate() || !running() || live.size > MAX_LIVE * 3 || $$('.pk:not(.ghost)', packetsG).length >= MAX_LIVE) return;
    if (now - lastLaunch < LAUNCH_GAP) return;
    const feature = !state.selected && !featuredInFlight && (forceFeature || (autoFeature && now - calloutAt > HOLD_MS - 1200));
    let rec = null;
    while (!rec && directed.length) { const d = directed.shift(); rec = typeof d === 'function' ? takeWhere(d) : takeFrom(d); }
    // explained frames alternate between verdicts when the traffic allows it
    if (!rec && feature) rec = lastFeatured === 'BLOCK' ? (takeFrom('fwdB') || takeFrom('fwdI')) : lastFeatured === 'FORWARD' ? (takeFrom('blkI') || takeFrom('blkB') || takeFrom('dropIn')) : null;
    for (let i = 0; !rec && i < ROTATION.length; i++) { rec = takeFrom(ROTATION[(rotation + i) % ROTATION.length]); if (rec) rotation = (rotation + i + 1) % ROTATION.length; }
    if (!rec) return;
    lastLaunch = now;
    if (feature) { featuredInFlight = true; forceFeature = false; }
    journey(rec, { feature });
  }
  /* Reduced motion: no movement — the callout, a still packet at its decision point,
     the bins and the ECU line update in place every ~3.5 s. */
  let lastReduced = 0, reducedFlip = 0;
  function reducedTick(now) {
    if (now - lastReduced < 3500 || !state.pageVisible) return;
    lastReduced = now;
    const order = reducedFlip++ % 2 ? ['fwdB', 'fwdI', 'blkI', 'blkB', 'dropEg', 'dropIn'] : ['blkI', 'blkB', 'dropIn', 'dropEg', 'fwdB', 'fwdI'];
    let rec = null;
    while (!rec && directed.length) { const d = directed.shift(); rec = typeof d === 'function' ? takeWhere(d) : takeFrom(d); }
    for (const c of order) { if (rec) break; rec = takeFrom(c); }
    const f = rec && rec.decision === 'FORWARD' ? rec : (takeFrom('fwdB') || takeFrom('fwdI')); if (f) arrive(f);
    if (rec && !state.selected) {
      setCallout(rec, 'sampled'); stillPacket(rec);
    }
  }
  setInterval(launcher, 120);

  /* ==========================================================================
     Selection: pin one recorded frame, highlight its journey (model keeps running)
     ========================================================================== */
  function pathFor(rec) {
    const cat = category(rec);
    if (cat === 'dropIn') return { cls: 'drp', d: `M${X.start} ${X.y}H${X.inq}V${X.laneY + 10}`, note: [214, 372, 'never entered CAN A'] };
    if (cat === 'dropEg') return { cls: 'drp', d: `M${X.start} ${X.y}H${X.egq}V${X.laneY + 10}`, note: [614, 372, 'passed checks · CAN B queue full'], x: true };
    if (cat === 'blkI' || cat === 'blkB') return { cls: 'blk', d: `M${X.start} ${X.y}H${X.wall}V${X.laneY + 10}`, x: true };
    return { cls: 'fwd', d: `M${X.start} ${X.y}H${X.ecu}`, end: true };
  }
  function drawSelection(rec, animate = true) {
    const p = pathFor(rec);
    let h = `<path class="hl-under ${p.cls}" d="${p.d}"/><path class="hl-line ${p.cls}" d="${p.d}"/>`;
    if (p.note) h += `<text class="hl-note" x="${p.note[0]}" y="${p.note[1]}" fill="var(--ink-2)">${esc(p.note[2])}</text>`;
    if (p.end) h += `<circle cx="${X.ecu + 24}" cy="${X.y}" r="7" fill="var(--ok)"/>`;
    hlG.innerHTML = h;
    $$('.pk.ghost', packetsG).forEach(g => g.remove());
    if (state.reduced || !animate) { stillPacket(rec, { ghost: true }); receipt(rec); }
    else { if (ov.arrive) ov.arrive.hidden = true; journey(rec, { ghost: true }); }
  }
  function selectFrame(rec, { reveal = false } = {}) {
    state.selected = rec;
    stage.classList.add('is-pinned');
    if (state.reduced) $$('.pk.still:not(.ghost)', packetsG).forEach(p => p.remove());
    setCallout(rec, 'pinned');
    drawSelection(rec);
    renderEvents(true);
    if (reveal) { const row = $(`#ev-list .ev[data-seq="${rec.seq}"]`); if (row) row.scrollIntoView({ block: 'nearest' }); }
  }
  function clearSelection() {
    state.selected = null; stage.classList.remove('is-pinned'); hlG.innerHTML = '';
    if (ov.arrive) { ov.arrive.hidden = true; ov.arrive.className = 'ovl arrive'; }
    $$('.pk.ghost', packetsG).forEach(g => g.remove());
    if (ov.callout) { calloutAt = 0; if (calloutRec) setCallout(calloutRec, 'sampled'); }
    renderEvents(true);
  }

  /* ==========================================================================
     Live model state → workbench
     ========================================================================== */
  const SPEED_WORD = { OBSERVE: 'Observe', WARN: 'Warn', FILTER: 'Filter', REQUEST_DEGRADE: 'Request degrade' };
  const GW_MODE = { OBSERVE: 'Rules active · observing', WARN: 'Rules active · warning', FILTER: 'Rules active · filtering', REQUEST_DEGRADE: 'Degradation requested' };   // project wording (web/app.js)
  function onLive(m) {
    if ((state.view === 'workbench') !== (m.session === 'bench') || state.view === 'intro') return;
    const sessionChanged = state.lastSession !== m.session || (state.live?.sessionId && state.live.sessionId !== m.sessionId);
    if (sessionChanged || (state.live && m.timeMs < state.live.timeMs)) {
      state.frames = []; state.notable = []; state.framesNext = null; pendingNew = 0;
      $('[data-ev-new]').hidden = true;
      clearPackets(); resetStageMemory(); clearSelection();
    }
    state.lastSession = m.session;
    if (sessionChanged) state.history = [];
    if (state.live && m.timeMs < state.live.timeMs) { state.history = []; resetStageMemory(); clearPackets(); clearSelection(); }   // reset happened
    state.live = m;
    addSamples(m.samples || []);
    setPlayback();
    renderStage(m);
    if (m.session === 'bench') { renderBench(m); lockControls(); }
  }

  let lastBlockAt = -1e9;
  function renderStage(m) {
    const met = m.metrics;
    const cc = m.catCount || {};
    if ((cc.blkI || 0) + (cc.blkB || 0) > 0) lastBlockAt = performance.now();
    if (ov.ctrA) {
      ov.ctrA.innerHTML = `offered <b>${n(met.received)}</b>`;
      ov.ctrB.innerHTML = `forwarded <b>${n(met.forwarded)}</b> → ECU`;
      $('[data-v]', ov.binIn).innerHTML = `${n(m.drops.ingress)} <small>since reset</small>`;
      $('[data-v]', ov.tray).innerHTML = `${n(met.blocked)} <small>since reset</small>`;
      $('[data-v]', ov.binEg).innerHTML = `${n(m.drops.egress)} <small>since reset</small>`;
      if (mqMobile.matches) { const sh = { binIn: m.drops.ingress, tray: met.blocked, binEg: m.drops.egress }; $$('[data-shelf]', net).forEach(t => { t.textContent = n(sh[t.dataset.shelf]); }); }
      if (!calloutRec && !state.selected) emptyCallout(m.running ? 'Waiting for a sampled frame…' : (met.received ? 'Model paused.' : 'Model paused · press Run to start traffic.'));
    }
    net.dataset.gw = m.status === 'OBSERVE' && performance.now() - lastBlockAt > 1500 ? 'forwarding' : 'containing';
    net.dataset.an = m.analyst.activeHolds && m.analyst.activeHolds.length ? 'anomaly' : 'clear';
    net.dataset.analyst = m.analyst.connected ? 'online' : 'offline';
    net.dataset.sf = m.safety.state === 'DEGRADED' ? (m.safety.recoveryEligible ? 'eligible' : 'degraded') : m.safety.state === 'REQUESTED' ? 'requested' : 'normal';
    const attackOn = m.activeAttacks && m.activeAttacks.length;
    net.dataset.attack = state.view === 'intro' ? '' : attackOn ? 'active' : (state.view === 'workbench' && state.sideTab === 'attack' ? 'armed' : '');
  }

  function renderBench(m) {
    const met = m.metrics;
    $('[data-clock]').textContent = clock(m.timeMs);
    // run controls reflect the model
    const runBtn = $('[data-run]');
    runBtn.setAttribute('aria-pressed', String(m.running));
    runBtn.innerHTML = m.running ? `${ICON('i-pause')}<span>Pause</span>` : `${ICON('i-play')}<span>Run</span>`;
    $('[data-step-sim]').disabled = m.running;
    const sp = $(`input[name="speed"][value="${m.speed}"]`); if (sp && !sp.checked) sp.checked = true;
    $('[data-profile-out]').textContent = m.profile === 'highway' ? 'Highway' : 'Urban';
    $('[data-seed-out]').textContent = m.seed;
    // vehicle as received by the protected ECU
    const v = m.vehicle;
    setV('speed', Number(v.speedKph).toFixed(1)); setV('rpm', n(v.rpm)); setV('brake', Number(v.brakePct).toFixed(0));
    setV('steer', Number(v.steeringDeg).toFixed(1)); setV('battery', Number(v.batteryPct).toFixed(1));
    setV('motor', v.motorEnabled ? 'On' : 'Off'); $('[data-motor-note]').textContent = v.motorEnabled ? 'enabled' : 'latched off';
    const targets = (m.activeAttacks || []).map(a => a.targetId);
    $$('.readout').forEach(r => r.classList.toggle('is-target', (r.dataset.ids || '').split(',').some(id => targets.includes(Number(id)))));
    // input vs outcome
    const a0 = m.activeAttacks && m.activeAttacks[0];
    $('[data-io-int]').textContent = a0 ? a0.strength.label : 'None';
    $('[data-io-bars]').dataset.level = a0 ? a0.intensity : 0;
    $('[data-io-sev]').textContent = GW_MODE[m.status] || m.status;
    $('[data-io-risk]').textContent = `threat score ${Math.round(m.risk)}/100`;
    // accounting (consistent window: since reset)
    const inQ = met.queueDepth;
    $('#accounting').innerHTML = `Since reset · sim ${clock(m.timeMs).slice(0, 7)} — offered <b>${n(met.received)}</b> = forwarded <b class="f">${n(met.forwarded)}</b> + blocked <b class="b">${n(met.blocked)}</b> + dropped <b>${n(met.dropped)}</b> + in queues <b>${n(inQ)}</b>`;
    // history for rails (sim time)
    const h = state.history; const prev = h[h.length - 1];
    if (!prev || prev.t !== m.timeMs) h.push({ t: m.timeMs, att: !!a0, blk: met.blocked, drp: met.dropped, fwd: met.forwarded, out: m.analyst.outliers, holds: (m.analyst.activeHolds || []).length, sf: m.safety.state, el: m.safety.recoveryEligible, off: !m.analyst.connected });
    while (h.length && h[0].t < m.timeMs - 61000) h.shift();
    renderRails(m);
    if (!prev || m.timeMs - (renderBench.lastTrack || 0) > 400 || m.timeMs < (renderBench.lastTrack || 0)) { renderTracks(); renderBench.lastTrack = m.timeMs; }
    renderCaption(m);
    renderAttackActive(m);
    renderLedger(m);
    $('[data-attack-dot]').hidden = !a0;
    $('[data-recover]').hidden = m.safety.state === 'NORMAL';
    $('[data-recover]').disabled = !m.safety.recoveryEligible;
    const sw = $('[data-analyst][type=checkbox]'); if (!sw.dataset.pending) sw.checked = m.analyst.connected;
  }
  function setV(sig, val) { const el = $(`.readout[data-sig="${sig}"] [data-v]`); if (el) el.textContent = val; }

  function chip(name, tone, icon, label, detail) {
    const row = $(`.rail[data-rail="${name}"]`); const c = $('.chip', row);
    const changed = c.dataset.tone && c.dataset.tone !== tone;
    if (c.dataset.label !== label || c.dataset.tone !== tone) { c.dataset.tone = tone; c.dataset.label = label; c.innerHTML = ICON(icon) + `<span>${esc(label)}</span>`; }
    const d = $('.rail-detail', row); if (d.textContent !== detail) { d.textContent = detail; d.title = detail; }
    if (changed && !state.reduced) { row.classList.remove('changed'); void row.offsetWidth; row.classList.add('changed'); setTimeout(() => row.classList.remove('changed'), 600); }
  }
  function scenarioName(id) { const s = state.catalog && state.catalog.scenarios.find(x => x.id === id); return s ? s.name : id; }
  function renderRails(m) {
    const atts = m.activeAttacks || [];
    if (!atts.length) chip('attack', 'quiet', 'i-none', 'No attack', 'The generator is offering baseline traffic only.');
    else { const a = atts[0]; chip('attack', 'input', 'i-input', `Active · ${a.strength.label}`, `${scenarioName(a.type)} → ${hex(a.targetId)} ${sigName(a.targetId)} · ${Math.max(0, (a.endsAtMs - m.timeMs) / 1000).toFixed(1)} s left · ${a.strength.description}${atts.length > 1 ? ` · +${atts.length - 1} more` : ''}`); }
    const r1 = lastSecond(), recent = r1 ? r1.blk : 0;
    let gw = { OBSERVE: ['quiet', 'i-forward', 'Monitoring traffic'], WARN: ['contain', 'i-contain', 'Suspicious traffic detected'], FILTER: ['contain', 'i-contain', 'Threat detected · filtering'], REQUEST_DEGRADE: ['contain', 'i-contain', 'Threat detected · safety requested'] }[m.status] || ['quiet', 'i-forward', m.status];
    if (m.status === 'OBSERVE' && recent > 0) gw = ['contain', 'i-contain', 'Blocking frames · rules active'];
    chip('gateway', gw[0], gw[1], gw[2], `${recent ? `${n(recent)} blocked in the last second · ` : ''}${n(m.metrics.blocked)} blocked · ${n(m.metrics.dropped)} dropped since reset · threat score ${Math.round(m.risk)}/100`);
    const an = m.analyst; const holds = an.activeHolds || [];
    if (!an.connected) chip('analyst', 'quiet', 'i-none', 'Offline', 'Gateway rules remain active without the analyst.');
    else if (holds.length) chip('analyst', 'warn', 'i-warn', 'Payload anomaly detected', `${n(an.processed)} payloads examined · ${n(an.outliers)} outliers · gateway holding ${holds.map(x => hex(x.id)).join(', ')}`);
    else if (!an.processed) chip('analyst', 'quiet', 'i-eye', 'Waiting for payloads', 'Receives copies of inspected payloads; not in the forwarding path.');
    else chip('analyst', 'quiet', 'i-eye', 'Monitoring · no active payload hold', `${n(an.processed)} payloads examined · ${n(an.outliers)} outliers this session`);
    const sf = m.safety;
    if (sf.state === 'NORMAL') {
      const c = sf.requestCriteria || {}; const missing = [!c.elevatedRisk && 'threat score ≥ 65', !c.sustainedThreat && 'sustained-threat confirmation', !c.criticalSignalEvidence && 'recent brake, steering or powertrain evidence'].filter(Boolean);
      chip('safety', 'quiet', 'i-brace', 'Shutdown not requested', m.status === 'OBSERVE' ? 'Independent safety task standing by.' : `Gateway protection active. A request needs all criteria${missing.length ? ` — still missing: ${missing.join('; ')}.` : '.'}`);
    } else if (sf.state === 'REQUESTED') chip('safety', 'crit', 'i-crit', 'Degradation requested', `${sf.reason} · acknowledgment pending (60 ms modeled).`);
    else if (sf.recoveryEligible) chip('safety', 'ok', 'i-recover', 'Recovery eligible', 'Quiet interval complete. The safety task will release the latch on an explicit recovery request.');
    else chip('safety', 'crit', 'i-crit', 'Degraded · safety latched', `${sf.reason}. Motor enable latched off. Recovery needs cleared attacks and a 2.5 s quiet interval.`);
  }
  function renderTracks() {
    const h = state.history; if (!h.length) return;
    const now = h[h.length - 1].t, x = (t) => Math.max(0, 196 - (now - t) / 60000 * 196);
    const spans = (pred) => { const out = []; let s = null; for (const p of h) { if (pred(p)) { if (s == null) s = p.t; } else if (s != null) { out.push([s, p.t]); s = null; } } if (s != null) out.push([s, now]); return out; };
    const base = '<line class="base" x1="0" y1="12" x2="200" y2="12"/>', nowLine = '<line class="now" x1="199" y1="0" x2="199" y2="24"/>';
    const rect = (cls, a, b, y = 7, hh = 10) => `<rect class="${cls}" x="${x(a).toFixed(1)}" y="${y}" width="${Math.max(1.5, x(b) - x(a)).toFixed(1)}" height="${hh}"/>`;
    const bins = (key) => { const out = []; for (let i = 0; i < 60; i++) { const t1 = now - i * 1000, t0 = t1 - 1000; const a = h.find(p => p.t >= t0), b = [...h].reverse().find(p => p.t <= t1); if (a && b && b[key] > a[key]) out.push([t1, b[key] - a[key]]); } return out; };
    $('.rail[data-rail="attack"] .rail-track').innerHTML = base + spans(p => p.att).map(([a, b]) => rect('tk-act', a, b)).join('') + nowLine;
    $('.rail[data-rail="gateway"] .rail-track').innerHTML = base + bins('blk').map(([t, c]) => { const hh = Math.min(20, 4 + Math.log10(c + 1) * 5); return `<rect class="tk-gw" x="${(x(t) - 2).toFixed(1)}" y="${12 - hh / 2}" width="2" height="${hh.toFixed(1)}"/>`; }).join('') + bins('drp').map(([t]) => `<rect class="tk-drop" x="${(x(t) - 2).toFixed(1)}" y="19" width="2" height="5"/>`).join('') + nowLine;
    $('.rail[data-rail="analyst"] .rail-track').innerHTML = base + spans(p => p.off).map(([a, b]) => rect('tk-off', a, b)).join('') + spans(p => p.holds > 0).map(([a, b]) => rect('tk-span-hold', a, b)).join('') + bins('out').map(([t]) => `<rect class="tk-warn" x="${(x(t) - 2).toFixed(1)}" y="5" width="2" height="14"/>`).join('') + nowLine;
    $('.rail[data-rail="safety"] .rail-track').innerHTML = base + spans(p => p.sf === 'REQUESTED').map(([a, b]) => rect('tk-span-req', a, b)).join('') + spans(p => p.sf === 'DEGRADED' && !p.el).map(([a, b]) => rect('tk-span-crit', a, b)).join('') + spans(p => p.el).map(([a, b]) => rect('tk-span-ok', a, b)).join('') + nowLine;
  }
  function lastSecond() {
    const h = state.history; if (h.length < 2) return null;
    const b = h[h.length - 1]; const a = [...h].reverse().find(p => p.t <= b.t - 1000) || h[0];
    if (b.t - a.t < 500) return null;
    const k = 1000 / (b.t - a.t);
    return { fwd: Math.round((b.fwd - a.fwd) * k), blk: Math.round((b.blk - a.blk) * k), drp: Math.round((b.drp - a.drp) * k) };
  }
  function renderCaption(m) {
    const el = $('#stage-caption'); const a = m.activeAttacks && m.activeAttacks[0]; const r = lastSecond();
    let html;
    if (m.source === 'imported') { el.innerHTML = '<b>Imported replay complete.</b> Inspect recorded decisions or export the trace. Reset to begin a new synthetic experiment.'; return; }
    if (!m.running && !m.metrics.received) html = '<b>Model paused.</b> Press Run to start traffic, or Step to advance 100 ms of simulated time.';
    else if (a) {
      const an = m.analyst.connected ? ((m.analyst.activeHolds || []).length ? 'analyst reports a payload anomaly (gateway hold active)' : 'analyst reports no active payload hold') : 'analyst offline';
      const sf = m.safety.state === 'NORMAL' ? 'safety task has not been asked to act' : m.safety.state === 'REQUESTED' ? 'degradation requested' : 'safety task has latched degraded mode';
      html = `<b>${esc(scenarioName(a.type))} on ${hex(a.targetId)} ${sigName(a.targetId)} · ${a.strength.label}.</b> ` + (r ? `In the last second the gateway forwarded ${n(r.fwd)}, blocked ${n(r.blk)}${r.drp ? ` and ${n(r.drp)} were dropped at a full queue` : ''}. ` : '') + `${an[0].toUpperCase() + an.slice(1)}; ${sf}.`;
    } else if (m.safety.state !== 'NORMAL') html = `<b>No attack active.</b> The safety latch keeps the gateway at “degradation requested” until an eligible recovery request${m.safety.recoveryEligible ? ' — recovery is now eligible' : ''}. Threat score ${Math.round(m.risk)}/100.`;
    else if (m.status !== 'OBSERVE') html = `<b>No attack active.</b> The gateway’s response level (${GW_MODE[m.status].toLowerCase()}) reflects recent evidence and decays as it ages.`;
    else html = '<b>Normal traffic.</b> Frames from all six signals pass the gateway checks and reach the protected ECU.';
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  /* ==========================================================================
     Evidence: ledger, reasons, frame list, Inspect frame journey
     ========================================================================== */
  function renderLedger(m) {
    const c = m.metrics;
    $('[data-n="received"]').textContent = n(c.received); $('[data-n="forwarded"]').textContent = n(c.forwarded);
    $('[data-n="blocked"]').textContent = n(c.blocked); $('[data-n="dropped"]').textContent = n(c.dropped);
    $('[data-ledger-time]').textContent = `sim ${clock(m.timeMs).slice(0, 7)}`;
    const tot = Math.max(1, c.received), sp = $('#split').children;
    sp[0].style.flex = c.forwarded / tot; sp[1].style.flex = c.blocked / tot; sp[2].style.flex = c.dropped / tot; sp[3].style.flex = c.queueDepth / tot;
    const reasons = m.blockReasons || [];
    const rows = reasons.slice(0, 4).map(([reason, count]) => `<li class="blk">${ICON('i-block')}<span>${esc(reason)}<span class="rule">${esc(RULE_OF[reason] || 'Gateway rule')} · blocked</span></span><span class="cnt">${n(count)}</span></li>`);
    if (m.drops.ingress) rows.push(`<li class="drp">${ICON('i-drop')}<span>Ingress queue capacity exceeded<span class="rule">CAN A ingress · availability loss, not a detection</span></span><span class="cnt">${n(m.drops.ingress)}</span></li>`);
    if (m.drops.egress) rows.push(`<li class="drp">${ICON('i-drop')}<span>Egress queue capacity exceeded<span class="rule">Gateway → CAN B · availability loss, not a detection</span></span><span class="cnt">${n(m.drops.egress)}</span></li>`);
    const html = rows.join('') || '<li class="empty">Nothing blocked or dropped yet — every inspected frame has been forwarded.</li>';
    const list = $('#why-list'); if (list.innerHTML !== html) list.innerHTML = html;
    const sum = c.forwarded + c.blocked + c.dropped + c.queueDepth;
    $('[data-acc-state]').textContent = sum === c.received ? 'balanced' : 'check';
    $('#validation').innerHTML = `<li>${sum === c.received ? `<svg class="ref-style-9" aria-label="Pass"><use href="#i-check"/></svg>` : `<svg class="ref-style-10" aria-label="Mismatch"><use href="#i-block"/></svg>`}<span>Offered = forwarded + blocked + dropped + in queues</span><span class="res">${n(c.received)} = ${n(sum)}</span></li>
      <li><svg class="ref-style-11" aria-label="Note"><use href="#i-info"/></svg><span>Drops are availability losses, not detections (engine counter scope)</span><span class="res">${n(c.dropped)}</span></li>
      <li><svg class="ref-style-11" aria-label="Note"><use href="#i-info"/></svg><span>Run the 12-case suite from Session tools</span><span class="res">independent run</span></li>`;
  }

  let listPointer = false, listFocus = false, pendingNew = 0, evTimer = null;
  let renderedFrames = new Map();
  const listHeld = () => listPointer || listFocus;   // the list holds still while it is being read or used
  function onFrames(m) {
    if (m.session !== 'bench') return;
    const newest = state.frames[0] && state.frames[0].seq;
    const wasReset = newest != null && (!m.frames.length || m.frames[0].seq < newest);
    if (listHeld() && !wasReset && state.frames.length) {
      // count only frames the current filters would list; the newest window is 150 frames
      const fresh = mergePool(m.frames, m.notable).filter(f => f.seq > newest && state.filters[f.decision]);
      const more = state.filters.FORWARD && m.frames.length && m.frames[m.frames.length - 1].seq > newest;
      pendingNew = fresh.length; if (pendingNew) showNew(more);
      state.framesNext = m; return;
    }
    if (wasReset) { pendingNew = 0; $('[data-ev-new]').hidden = true; }
    applyFrames(m);
    if (state.sideTab === 'evidence' || state.mtab === 'evidence') renderEventsThrottled();
  }
  function applyFrames(m) {
    state.frames = m.frames; state.notable = m.notable || []; state.framesNext = null;
    $('[data-ev-count]').textContent = n(evidencePool().length);
  }
  /* Newest frames of every outcome, plus the newest blocked / dropped frames of the session,
     so a rare rejection can still be inspected after it scrolls out of the newest window. */
  function mergePool(frames, notable) {
    const byId = new Map(); for (const f of frames || []) byId.set(f.seq, f); for (const f of notable || []) if (!byId.has(f.seq)) byId.set(f.seq, f);
    return [...byId.values()].sort((a, b) => b.seq - a.seq);
  }
  const evidencePool = () => mergePool(state.frames, state.notable);
  function showNew(more) { const b = $('[data-ev-new]'); b.hidden = false; b.textContent = `${n(pendingNew)}${more ? '+' : ''} new frame${pendingNew > 1 || more ? 's' : ''} · show latest`; }
  function renderEventsThrottled() { if (evTimer) return; evTimer = setTimeout(() => { evTimer = null; if (!listHeld()) renderEvents(); }, 300); }
  function journeyHTML(r) {
    const ing = r.decision === 'DROP' && r.reasons[0].startsWith('Ingress');
    const egr = r.decision === 'DROP' && !ing;
    const src = r.label === 'attack' ? `<b class="ref-style-12">Injected frame</b>${r.attackType ? ` · ${esc(scenarioName(r.attackType))}` : ''}` : r.label === 'normal' ? 'Baseline frame' : 'Unlabelled frame';
    const reasons = r.decision === 'BLOCK' ? `<ul class="reasons">${r.reasons.map(x => `<li>${esc(x)} <span class="ref-style-11">· ${esc(RULE_OF[x] || 'gateway rule')}</span></li>`).join('')}</ul>` : '';
    return `<ol class="journey">
      <li class="ok"><span><b>Source · ${state.live?.source === 'imported' ? 'imported trace' : 'ESP32'}</b>${src} · offered at ${clock(r.timestampMs)}<br><span class="ref-style-13">Origin is a scoring label from the generator or imported trace; the gateway never sees it.</span></span></li>
      <li class="${ing ? 'stop drop' : 'ok'}"><span><b>Incoming · CAN A</b>${ing ? 'Not transmitted — <strong>Ingress queue capacity exceeded</strong>. An availability loss, not a detection.' : 'Queued in the bounded CAN A queue and transmitted to the gateway.'}</span></li>
      <li class="${ing ? 'na' : r.decision === 'FORWARD' ? 'ok' : 'stop' + (egr ? ' drop' : '')}"><span><b>Gateway verdict · STM32</b>${ing ? 'Never inspected.' : r.decision === 'FORWARD' ? `<span class="verdict FORWARD">${ICON('i-forward')}Forwarded</span> — gateway checks passed.` : r.decision === 'BLOCK' ? `<span class="verdict BLOCK">${ICON('i-block')}Blocked</span> — stopped at the gateway boundary.${reasons}` : `<span class="verdict DROP">${ICON('i-drop')}Dropped</span> — checks passed, then <strong>Egress queue capacity exceeded</strong>. Not a detection.`}</span></li>
      <li class="${r.decision === 'FORWARD' ? 'ok' : 'na'}"><span><b>Downstream · CAN B → protected ECU</b>${r.decision === 'FORWARD' ? `Delivered to the protected ECU · modeled latency ${Number(r.latencyUs).toFixed(1)} µs.` : 'Never sent on CAN B — the protected ECU did not receive it.'}</span></li>
    </ol>`;
  }
  function detailHTML(r) {
    return `<div class="inspect"><div class="inspect-h"><span class="label">Inspect frame #${r.seq}</span>${state.selected && state.selected.seq === r.seq ? `<button type="button" class="btn btn-quiet btn-sm" data-unpin-row>Unpin</button>` : `<button type="button" class="btn btn-quiet btn-sm" data-pin="${r.seq}">${ICON('i-pin')}Show on diagram</button>`}</div>${journeyHTML(r)}</div>
      <div class="ev-meta"><span>CAN ID <b>${hex(r.id)}</b> · DLC <b>${r.dlc}</b></span><span>Threat score at decision <b>${Number(r.risk).toFixed(0)}</b></span>
      <span>Analyst score <b>${Number(r.anomalyScore).toFixed(3)}</b> <span title="Score from the copied observation; the analyst is not in the forwarding path">(copy)</span></span><span>Data <b class="bytes">${(r.data || []).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ') || '—'}</b></span></div>`;
  }
  function rowHTML(r, expanded) {
    const word = r.decision === 'FORWARD' ? 'Forwarded' : r.decision === 'BLOCK' ? 'Blocked' : 'Dropped';
    const icon = r.decision === 'FORWARD' ? 'i-forward' : r.decision === 'BLOCK' ? 'i-block' : 'i-drop';
    return `<div class="ev${expanded ? ' is-selected' : ''}" role="listitem" data-seq="${r.seq}">
      <button type="button" aria-expanded="${expanded}" aria-controls="evd-${r.seq}">
        <span class="t">${clock(r.timestampMs)}</span><span class="id">${hex(r.id)}</span>
        <span class="sig"><i class="sw ${r.label === 'attack' ? 'inj' : 'base'}" title="${r.label === 'attack' ? 'Injected frame' : r.label === 'normal' ? 'Baseline frame' : 'Unlabelled frame'}"></i>${esc(r.signal === 'Unknown' ? 'Unknown ID' : r.signal)}${r.label === 'attack' ? ' <span class="sr-only">(injected)</span>' : ''}</span>
        <span class="oc ${r.decision}">${ICON(icon)}${word}</span>
      </button>
      <div class="ev-detail" id="evd-${r.seq}"><div>${expanded ? detailHTML(r) : ''}</div></div></div>`;
  }
  function renderEvents(force) {
    const list = $('#ev-list');
    const sel = state.selected;
    const rows = evidencePool().filter(f => state.filters[f.decision]).slice(0, 210);
    let html = '';
    if (sel && !rows.some(r => r.seq === sel.seq)) html += `<p class="ref-style-14 label">Pinned frame (no longer in the newest window)</p>` + rowHTML(sel, true);
    html += rows.map(r => rowHTML(r, !!(sel && sel.seq === r.seq))).join('') || '<p class="ref-style-15">No frames yet. Run or step the model.</p>';
    if (!force && list.innerHTML === html) return;
    // Bind interaction to the record actually displayed. The next worker update
    // can replace the live window before a throttled DOM update or pointer entry.
    renderedFrames = new Map(rows.map(r => [r.seq, r]));
    if (sel) renderedFrames.set(sel.seq, sel);
    const ae = document.activeElement, row = ae && ae.closest && ae.closest('#ev-list .ev'), keep = row ? row.dataset.seq : null;
    list.innerHTML = html;
    if (keep) { const b2 = $(`#ev-list .ev[data-seq="${keep}"] > button`); if (b2) b2.focus({ preventScroll: true }); }   // re-rendering never drops keyboard focus
  }
  $('#ev-list').addEventListener('click', (e) => {
    const pin = e.target.closest('[data-pin]'); if (pin) { const r = findFrame(Number(pin.dataset.pin)); if (r) selectFrame(r); return; }
    if (e.target.closest('[data-unpin-row]')) { clearSelection(); return; }
    const row = e.target.closest('.ev > button'); if (!row) return;
    const seq = Number(row.parentElement.dataset.seq);
    if (state.selected && state.selected.seq === seq) clearSelection();
    else { const r = findFrame(seq); if (r) selectFrame(r); }
    const again = $(`#ev-list .ev[data-seq="${seq}"] > button`);
    if (again) { again.focus({ preventScroll: true }); again.parentElement.scrollIntoView({ block: 'nearest', behavior: state.reduced ? 'auto' : 'smooth' }); }   // keep focus on the re-rendered row; reveal its detail
  });
  function findFrame(seq) { return renderedFrames.get(seq) || evidencePool().find(f => f.seq === seq) || (state.selected && state.selected.seq === seq ? state.selected : null); }
  const evl = $('#ev-list');
  evl.addEventListener('pointerenter', () => { listPointer = true; }); evl.addEventListener('pointerleave', () => { listPointer = false; });
  evl.addEventListener('focusin', () => { listFocus = true; }); evl.addEventListener('focusout', (e) => { if (e.relatedTarget && evl.contains(e.relatedTarget)) return; setTimeout(() => { listFocus = evl.contains(document.activeElement); }, 0); });
  $('[data-ev-new]').addEventListener('click', () => { pendingNew = 0; $('[data-ev-new]').hidden = true; if (state.framesNext) applyFrames(state.framesNext); renderEvents(true); });
  $('#ledger').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.oc === 'received') { for (const k in state.filters) state.filters[k] = true; }
    else state.filters[b.dataset.oc] = !state.filters[b.dataset.oc];
    $$('#ledger button[aria-pressed]').forEach(x => x.setAttribute('aria-pressed', String(state.filters[x.dataset.oc])));
    renderEvents(true);
  });
  function openEvidence() { openPanel('evidence'); }

  /* ==========================================================================
     Attack configuration (real families, targets, durations, intensity text)
     ========================================================================== */
  const LEVEL_NAMES = ['Low', 'Moderate', 'High', 'Severe', 'Maximum'];
  function describe(type, level) { const d = state.catalog && state.catalog.intensities.find(x => x.id === type); return d ? d.levels[level - 1] : { label: LEVEL_NAMES[level - 1], description: '' }; }
  function buildAttackForm() {
    const cat = state.catalog; if (!cat) return;
    $('#families').innerHTML = cat.scenarios.map(s => `<div class="fam"><input type="radio" name="family" id="fam-${s.id}" value="${s.id}" ${s.id === state.attack.type ? 'checked' : ''}><label for="fam-${s.id}"><svg viewBox="0 0 56 18" aria-hidden="true">${PICTS[s.id] || ''}</svg><b>${esc(s.name)}</b><span>${esc(s.description)}</span></label></div>`).join('');
    $('#levels').innerHTML = LEVEL_NAMES.map((name, i) => `<div class="lvl"><input type="radio" name="level" id="lvl-${i + 1}" value="${i + 1}" ${i + 1 === state.attack.intensity ? 'checked' : ''}><label for="lvl-${i + 1}"><span class="bars" data-level="${i + 1}" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>${name}</label></div>`).join('');
    updateAttackSummary();
  }
  $('#attack-form').addEventListener('change', (e) => {
    const f = e.target;
    if (f.name === 'family') state.attack.type = f.value;
    if (f.name === 'level') state.attack.intensity = Number(f.value);
    if (f.name === 'target') state.attack.targetId = Number(f.value);
    if (f.name === 'duration') state.attack.durationMs = Number(f.value);
    cancelConfirm(); updateAttackSummary();
  });
  function updateAttackSummary() {
    const a = state.attack, d = describe(a.type, a.intensity);
    $('#intensity-preview').innerHTML = `<span class="model">${esc(d.description)}</span><b>${esc(d.label)}</b> selected — an input. It sets how hard the generator applies this attack. The gateway, analyst and safety task respond only to the traffic they observe.`;
    $('#summary-line').innerHTML = `<b>${esc(scenarioName(a.type))}</b> → ${hex(a.targetId)} ${sigName(a.targetId)} · ${a.durationMs / 1000} s · <b>${esc(d.label)}</b>`;
    const notes = { fuzzing: 'Fuzzing ignores the target: it sends unknown identifiers 0x600–0x6FF with random lengths.', payload: 'Replaces the value in a share of the target’s own frames; timing stays valid.', stealth: 'Drifts the target’s own, correctly timed payload toward an extreme value.', flooding: 'Floods CAN A with copies of a captured target frame.', spoofing: 'A second source sends the target identifier with invalid timing and counters.', replay: 'Re-sends a captured target payload and rolling counter.' };
    $('[data-target-note]').textContent = notes[a.type] || '';
  }
  function cancelConfirm() { if (state.confirming) { state.confirming = false; $('[data-cta-confirm]').hidden = true; $('[data-cta-idle]').hidden = false; } }
  $('[data-inject]').addEventListener('click', () => {
    const a = state.attack, d = describe(a.type, a.intensity);
    if (!online || commandPending || state.live?.source === 'imported') return;
    state.confirming = true;
    $('#confirm-text').innerHTML = `Inject <b>${esc(scenarioName(a.type))}</b> into CAN A, targeting <b>${hex(a.targetId)} ${sigName(a.targetId)}</b> for <b>${a.durationMs / 1000} s</b> at <b>${esc(d.label)}</b> intensity? <span class="ref-style-16">${esc(d.description)}</span>`;
    $('[data-cta-idle]').hidden = true; $('[data-cta-confirm]').hidden = false; $('[data-confirm]').focus();
  });
  $('[data-cancel]').addEventListener('click', () => { cancelConfirm(); $('[data-inject]').focus(); });
  $('[data-confirm]').addEventListener('click', async () => {
    if (commandPending) return;
    commandPending = true; lockControls();
    cancelConfirm();
    try {
      await cmd('attack', { attack: { type: state.attack.type, targetId: state.attack.targetId, durationMs: state.attack.durationMs, intensity: state.attack.intensity } });
      $('[data-attack-hint]').textContent = running() ? 'Attack injected. Watch the gateway response and decision evidence.' : 'Attack scheduled. Run or step the simulation to advance it.';
      if (!state.reduced) $('.inject-mark').animate([{ strokeWidth: 2 }, { strokeWidth: 6 }, { strokeWidth: 2 }], { duration: 420, easing: css('--ease-out') });
    } catch (err) { $('[data-attack-hint]').textContent = err.message; } finally { commandPending = false; lockControls(); }
  });
  $('[data-stop]').addEventListener('click', () => cmd('clear-attacks').then(() => { $('[data-attack-hint]').textContent = 'Attack sources stopped. Queued frames and pending analyst evidence are still processed.'; }).catch(() => {}));
  function renderAttackActive(m) {
    const atts = m.activeAttacks || []; const box = $('[data-active-box]');
    box.hidden = !atts.length;
    if (!atts.length) return;
    const a = atts[0];
    $('[data-active-summary]').textContent = `${scenarioName(a.type)} → ${hex(a.targetId)} ${sigName(a.targetId)} · ${a.strength.label}${atts.length > 1 ? ` · +${atts.length - 1} more` : ''}`;
    $('[data-active-effect]').textContent = a.strength.description;
    $('[data-remaining]').textContent = `${Math.max(0, (a.endsAtMs - m.timeMs) / 1000).toFixed(1)} s left`;
    $('[data-progress]').style.width = `${Math.min(100, (m.timeMs - a.startsAtMs) / Math.max(1, a.endsAtMs - a.startsAtMs) * 100)}%`;
  }

  /* ---------------- side tabs, mobile tab bar ---------------- */
  function setSideTab(t) {
    state.sideTab = t;
    if ($('#workspace-panel').open) $('#workspace-panel-title').textContent = t === 'attack' ? 'Configure attack' : 'Frame evidence';
    $$('.tab').forEach(b => { const on = b.id === 'tab-' + t; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    $('#tp-attack').hidden = t !== 'attack'; $('#tp-evidence').hidden = t !== 'evidence';
    if (t === 'evidence') renderEvents(true);
    if (state.live) renderStage(state.live);
  }
  $$('.tab').forEach(b => b.addEventListener('click', () => setSideTab(b.id.replace('tab-', ''))));
  $('.tabs').addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const t = state.sideTab === 'attack' ? 'evidence' : 'attack'; setSideTab(t); $('#tab-' + t).focus(); } });
  function setMTab(t) {
    state.mtab = t; $('#bench-grid').dataset.mtab = t;
    $$('.tabbar button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mtab === t)));
    if (t === 'attack' || t === 'evidence') setSideTab(t);
  }
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => { setMTab(b.dataset.mtab); }));
  function placeSimControls() {
    const parts = ['.ctl-speed', '.ctl-profile', '.ctl-seed', '.ctl-reset'].map(s => $(s));
    const target = $('#m-sim-slot');
    parts.forEach(p => target.appendChild(p));
    $('#m-sim-slot').style.cssText = 'display:flex;flex-direction:column;gap:16px;align-items:flex-start';
  }
  mqMobile.addEventListener('change', () => { placeSimControls(); placeCallout(); layoutOverlay(); });

  const panelNames = { attack: 'Configure attack', evidence: 'Frame evidence', signals: 'Vehicle signals', status: 'System status', sim: 'Simulation settings' };
  let panelNodes;
  const vehicleInline = matchMedia('(min-width: 701px)');
  function placeVehicleReadings() {
    const values = $('.readouts');
    if (vehicleInline.matches) $('#vehicle-live-values').appendChild(values);
    else $('.signals').insertBefore(values, $('.signals .sim-clock'));
  }
  vehicleInline.addEventListener('change', placeVehicleReadings);
  function setupPanels() {
    panelNodes = { attack: $('.panel.side'), evidence: $('.panel.side'), signals: $('.signals'), status: $('.rails'), sim: $('.m-sim') };
    [...new Set(Object.values(panelNodes))].forEach(node => $('#workspace-panel-body').appendChild(node));
    placeVehicleReadings();
    $$('button[data-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.panel)));
    $('[data-close-panel]').addEventListener('click', () => $('#workspace-panel').close());
    $('[data-show-journey]').addEventListener('click', () => $('#workspace-panel').close());
    $('#workspace-panel').addEventListener('click', e => { if (e.target === $('#workspace-panel')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
  }
  function openPanel(name) {
    const dialog = $('#workspace-panel');
    $('#workspace-panel-title').textContent = panelNames[name];
    [...new Set(Object.values(panelNodes))].forEach(node => { node.hidden = node !== panelNodes[name]; });
    dialog.dataset.panel = name;
    if (name === 'attack' || name === 'evidence') setSideTab(name);
    if (!dialog.open) dialog.showModal();
  }

  /* ==========================================================================
     Simulation controls → the engine's own public commands
     ========================================================================== */
  $('[data-run]').addEventListener('click', () => { const on = !running(); $('[data-run]').setAttribute('aria-pressed', String(on)); cmd(on ? 'start' : 'pause').catch(() => {}); });
  $('[data-step-sim]').addEventListener('click', () => cmd('step', { milliseconds: 100 }).catch(err => { $('#stage-caption').textContent = err.message; }));
  $$('input[name="speed"]').forEach(r => r.addEventListener('change', () => cmd('speed', { speed: Number(r.value) }).catch(() => {})));
  $('[data-reset]').addEventListener('click', () => {
    const raw = $('[data-seed]').value.trim(); const seed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seed) || seed > 4294967295) { $('#stage-caption').textContent = 'Enter a whole-number seed between 0 and 4,294,967,295.'; return; }
    clearPackets(); clearSelection(); resetStageMemory(); state.history = [];
    cmd('reset', { seed, profile: $('[data-profile]').value }).catch(err => { $('#stage-caption').textContent = err.message; });
  });
  $('[data-analyst][type=checkbox]').addEventListener('change', (e) => { const sw = e.target; sw.dataset.pending = '1'; cmd('analyst', { connected: sw.checked }).catch(() => {}).finally(() => { delete sw.dataset.pending; }); });
  $('[data-recover]').addEventListener('click', () => cmd('recover').catch(err => { $('.rail[data-rail="safety"] .rail-detail').textContent = err.message; }));


  /* ---------------- navigation, visibility ---------------- */
  $$('[data-go]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); const v = a.dataset.go; if (location.hash !== '#' + v) history.pushState(null, '', '#' + v); navigateTo(v); }));
  window.addEventListener('popstate', routeFromHash);
  document.addEventListener('visibilitychange', () => { state.pageVisible = !document.hidden; setPlayback(); });
  new IntersectionObserver(es => { es.forEach(e => { state.stageVisible = e.isIntersecting; }); setPlayback(); }, { threshold: 0.05 }).observe(stage);
  new ResizeObserver(() => { resizeField(); layoutOverlay(); }).observe(stage);

  // Production controls, connection states and existing laboratory tools.
  let online = false, commandPending = false, imported = false;
  function showError(message) {
    const el = $('#session-notice'); el.hidden = false; el.textContent = message; el.dataset.userError = 'true';
  }
  function lockControls() {
    $$('[data-run], [data-step-sim], [data-reset], input[data-analyst], [data-inject], [data-confirm], [data-stop], [data-recover], input[name="speed"]').forEach(el => {
      el.disabled = !online || commandPending || (imported && !el.matches('[data-reset]'));
    });
    if (online && !commandPending && !imported) {
      $('[data-step-sim]').disabled = !!state.live?.running;
      $('[data-recover]').disabled = !state.live?.safety?.recoveryEligible;
      $('[data-stop]').disabled = !state.live?.activeAttacks?.length;
    }
  }
  function connection(m) {
    if (state.view !== 'workbench') { if (m.error) $('#arch-annot').textContent = m.error; return; }
    online = m.online; imported = m.source === 'imported';
    const notice = $('#session-notice');
    $('[data-session-status]').textContent = m.loading ? 'Initializing…' : online ? (imported ? 'Imported trace' : 'Live engine') : 'Disconnected';
    if (!online) {
      showError(m.loading ? 'Initializing the simulation. Controls will be ready shortly.' : `${m.error || 'Simulation unavailable.'} Displaying the last received state. Reload to reconnect.`);
      delete notice.dataset.userError;
      clearPackets();
    } else if (imported) { showError('Completed imported replay. Inspect or export this trace. Reset to run a new synthetic experiment.'); delete notice.dataset.userError; }
    else if (m.storage?.error) showError(m.storage.error);
    else if (!notice.dataset.userError) notice.hidden = true;
    $('[data-storage-note]').textContent = document.documentElement.dataset.runtime === 'browser'
      ? 'This tab has its own session. Export evidence before closing or reloading.'
      : 'Local server session · shared with other local views. Evidence is saved on this computer when storage is available.';
    lockControls();
  }
  $('#attack-form').addEventListener('submit', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.confirming) { cancelConfirm(); $('[data-inject]').focus(); }
  });
  const toolsDialog = $('#session-tools');
  $$('[data-open-tools]').forEach(b => b.addEventListener('click', () => toolsDialog.showModal()));
  $('[data-close-tools]').addEventListener('click', () => toolsDialog.close());
  const toolMessage = message => { $('#tools-message').textContent = message; };
  $$('[data-export]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await engine.download(b.dataset.export); toolMessage('Evidence downloaded.'); }
    catch (e) { toolMessage(e.message); }
    finally { b.disabled = false; }
  }));
  $('[data-import]').addEventListener('click', async () => {
    const file = $('#trace-file').files[0];
    if (!file) return toolMessage('Choose a CSV or candump trace first.');
    if (file.size > 2000000) return toolMessage('Trace is larger than the 2 MB limit.');
    if (commandPending) return;
    const b = $('[data-import]'); b.disabled = true; commandPending = true; lockControls();
    try {
      await engine.init();
      const result = await engine.request('/api/import', { text: await file.text(), format: file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'candump' });
      engine.emitSnapshot(result.snapshot); clearSelection(); clearPackets(); resetStageMemory();
      toolMessage(`Imported ${n(result.summary.frames)} frames.${result.summary.warnings?.length ? ' ' + result.summary.warnings.join(' ') : ''}`);
    } catch (e) { toolMessage(e.message); }
    finally { commandPending = false; b.disabled = false; lockControls(); }
  });
  $('[data-validate]').addEventListener('click', async () => {
    const b = $('[data-validate]'); b.disabled = true; b.textContent = 'Validation running…';
    toolMessage('Running synthetic acceptance cases in a separate worker.');
    try {
      await engine.init();
      const report = await engine.request('/api/validation', { seed: state.live?.seed ?? 42 });
      const result = report.report || report;
      $('#validation-results').innerHTML = `<p><strong>${result.summary.passed} / ${result.summary.total} passed</strong> · synthetic acceptance cases</p><ul>${result.cases.map(c => `<li>${c.passed ? '✓' : '✕'} ${esc(c.name)}</li>`).join('')}</ul>`;
      toolMessage('Validation complete. The active experiment was preserved.');
    } catch (e) { toolMessage(e.message); }
    finally { b.disabled = false; b.textContent = 'Run 12-case validation'; }
  });

  /* ---------------- boot ---------------- */
  if (['traffic', 'validation', 'guide'].includes(location.hash.slice(1))) { location.replace('/laboratory/' + location.hash); return; }
  makeOverlay(); buildMarks(); makeStaticStages(); setupPanels(); placeSimControls(); applyReduced();
  const startView = routeName();
  navigateTo(VIEWS.includes(startView) ? startView : 'intro', true);
  if (state.view === 'intro') playIntro();
  lockControls();
  startEngine().catch(e => showError(e.message));
})();
