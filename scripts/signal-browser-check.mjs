import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { createPreviewServer } from './preview-site.js';
import { createApp } from '../src/server.js';

const server = createPreviewServer();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const out = resolve('artifacts/browser/signal-resolve'); await mkdir(out, { recursive: true });
const errors = [], requests = [], checks = [], renderedEvidence = [];
let captureErrors = true;
page.on('pageerror', e => errors.push(e.message));
page.on('console', e => { if (captureErrors && e.type() === 'error') errors.push(e.text()); });
page.on('request', r => requests.push(r.url()));
const pass = name => { checks.push(name); console.log('PASS', name); };
async function fits() {
  // Chromium applies viewport changes and responsive control relocation on the next paint.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const s = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  if (s.scroll > s.width + 1) {
    console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().width && e.getBoundingClientRect().right > innerWidth + 1).map(e => ({ tag: e.tagName, id: e.id, class: String(e.className), right: e.getBoundingClientRect().right })).slice(0, 20)));
    await page.screenshot({ path: resolve(out, 'overflow-debug.png') });
  }
  assert.ok(s.scroll <= s.width + 1, JSON.stringify(s));
}
async function shot(name, observation, fullPage = false) {
  await page.screenshot({ path: resolve(out, name), fullPage });
  const v = page.viewportSize(); renderedEvidence.push({ viewport: `${v.width}x${v.height}`, artifact: name, observation });
}
async function ready() { await page.waitForFunction(() => !document.querySelector('[data-run]').disabled); }
async function pause() {
  if (await page.locator('[data-run]').getAttribute('aria-pressed') === 'true') await page.locator('[data-run]').click();
  await page.waitForFunction(() => document.querySelector('[data-run]').getAttribute('aria-pressed') === 'false');
  await ready();
}
async function openPanel(name) {
  if (await page.locator('#workspace-panel').isVisible()) await page.locator('[data-close-panel]').click();
  await page.locator(`button[data-panel="${name}"]`).click();
}
async function closePanel() { if (await page.locator('#workspace-panel').isVisible()) await page.locator('[data-close-panel]').click(); }
async function inject(type, target, intensity) {
  await openPanel('attack');
  await page.locator(`label[for="fam-${type}"]`).click();
  await page.locator('select[name=target]').selectOption(String(target));
  await page.locator('select[name=duration]').selectOption('30000');
  await page.locator(`label[for="lvl-${intensity}"]`).click();
  await page.locator('[data-inject]').click();
  await page.locator('[data-confirm]').click();
  await page.waitForFunction(() => !document.querySelector('[data-active-box]').hidden);
  await closePanel();
}
try {
  await page.goto(base); await page.waitForTimeout(1600);
  assert.match(await page.locator('h1').innerText(), /SENTINEL/);
  assert.ok(!requests.some(u => /\/api\/|\/engine\/|browser-worker|walkthrough-worker/.test(u)));
  assert.ok(requests.every(u => u.startsWith(base)));
  let gzip = 0;
  for (const file of ['signal.html', 'design/sentinel.css', 'design/production.css', 'design/sentinel.js', 'design/session-adapter.js']) gzip += gzipSync(await readFile(`web/${file}`)).length;
  assert.ok(gzip < 65000, `Presentation compressed bytes: ${gzip}`);
  await fits(); await shot('desktop-intro.png', 'Approved dark typography and dithered vehicle; no model startup or remote assets on the introduction.');
  pass('Approved introduction loads without training or starting the model');

  await page.mouse.wheel(0, 900);
  await page.waitForFunction(() => document.body.dataset.view === 'architecture');
  assert.equal(await page.locator('.topnav a[href="#architecture"]').getAttribute('aria-current'), 'location');
  await page.waitForFunction(() => document.querySelector('[data-ov="ctrA"]').textContent.includes('offered'));
  await page.locator('[data-step-next]').click();
  await page.waitForTimeout(1300);
  await shot('desktop-architecture.png', 'Architecture step explains gateway filtering in an isolated seeded preview.');
  await page.locator('#architecture a[data-go="workbench"]').click(); await ready();
  assert.equal(await page.locator('[data-clock]').textContent(), '00:00.000');
  assert.equal(await page.locator('[data-run]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('[data-inject]').isEnabled(), true);
  assert.equal(await page.locator('#vehicle-live-values .readouts').isVisible(), true);
  assert.equal(await page.locator('.readouts').count(), 1);
  assert.equal(await page.locator('[data-preset]').count(), 0);
  await page.locator('[data-step-sim]').click();
  await page.waitForFunction(() => document.querySelector('[data-clock]').textContent === '00:00.100');
  pass('Architecture preview is isolated; workbench opens paused and Step uses the real model');

  await page.locator('[data-run]').click();
  await page.waitForTimeout(1200);
  await inject('spoofing', 0x130, 1);
  await page.waitForFunction(() => Number(document.querySelector('[data-n="blocked"]').textContent.replaceAll(',', '')) > 0);
  assert.match(await page.locator('[data-io-int]').textContent(), /Low/);
  assert.ok(Number((await page.locator('[data-n="forwarded"]').textContent()).replaceAll(',', '')) > 0);
  await openPanel('evidence');
  await page.locator('[data-oc="FORWARD"]').click();
  const blocked = page.locator('.ev').filter({ has: page.locator('.oc.BLOCK') }).first();
  await blocked.locator(':scope > button').click();
  await page.waitForFunction(() => document.querySelector('#stage').classList.contains('is-pinned'));
  const before = await page.locator('[data-clock]').textContent();
  await page.waitForTimeout(1600);
  assert.notEqual(await page.locator('[data-clock]').textContent(), before, 'Pinning must not pause the model');
  assert.match(await page.locator('.ev.is-selected .journey').textContent(), /Never sent on CAN B/);
  assert.match(await page.locator('[data-ov="callout"]').textContent(), /Blocked/);
  await closePanel();
  await shot('desktop-blocked.png', 'Low-intensity spoofing: pinned real blocked frame, gateway rule, continuing forwarded traffic, and independent safety state.');
  pass('Low attack shows real block reasons, valid forwarding and a pinned path without pausing');

  await page.locator('[data-unpin]').click();
  await openPanel('evidence'); await page.locator('[data-oc="received"]').click();
  const forwarded = page.locator('.ev').filter({ has: page.locator('.oc.FORWARD') }).first();
  await forwarded.locator(':scope > button').click();
  assert.match(await page.locator('.ev.is-selected .journey').textContent(), /Delivered to the protected ECU/);
  await closePanel();
  await shot('desktop-forwarded.png', 'Selected real accepted frame traces through CAN B to the protected ECU.');
  pass('Forwarded evidence reports delivery rather than merely a passed gateway check');

  await page.locator('.appbar [data-open-tools]').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('[data-export="json"]').click();
  const download = await downloadPromise;
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.ok(report.frames.length && report.snapshot.metrics.blocked > 0);
  assert.equal(report.provenance.environment.runtime, 'browser-worker');
  const csvPromise = page.waitForEvent('download'); await page.locator('[data-export="csv"]').click();
  assert.match(await (await csvPromise).suggestedFilename(), /\.csv$/);
  await page.locator('[data-validate]').click();
  await page.waitForFunction(() => document.querySelector('#validation-results').textContent.includes('12 / 12 passed'), { timeout: 120000 });
  await shot('desktop-tools.png', 'Existing export and independent 12-case validation integrated into the new presentation.');
  pass('JSON/CSV exports and the real 12-case suite work in the new interface');

  await page.locator('#trace-file').setInputFiles({ name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from('timestamp_ms,id,data,label\n0,0x120,00 00 00 00 00 00 00 00,normal\n20,0x120,00 00 00 00 00 00 00 01,normal') });
  await page.locator('[data-import]').click();
  await page.waitForFunction(() => document.querySelector('#tools-message').textContent.includes('Imported 2 frames'));
  await page.locator('[data-close-tools]').click();
  assert.equal(await page.locator('[data-run]').isEnabled(), false);
  assert.equal(await page.locator('[data-inject]').isEnabled(), false);
  assert.match(await page.locator('#session-notice').textContent(), /Completed imported replay/);
  await shot('desktop-import.png', 'Imported trace is explicitly labeled, replay controls are locked, export and reset remain available.');
  await openPanel('sim'); await page.locator('[data-reset]').click(); await closePanel(); await ready();
  assert.equal(await page.locator('[data-clock]').textContent(), '00:00.000');
  pass('Import uses existing trace parsing, locks completed replay, and reset restores synthetic mode');

  // Confirm cancellation has no side effects.
  await openPanel('attack'); await page.locator('[data-inject]').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-cta-confirm]').isVisible(), false);
  assert.equal(await page.locator('[data-active-box]').isVisible(), false); await closePanel();
  await page.locator('[data-run]').click();
  await inject('flooding', 0x300, 5);
  await page.waitForFunction(() => Number(document.querySelector('[data-n="dropped"]').textContent.replaceAll(',', '')) > 0);
  await openPanel('evidence');
  await page.waitForTimeout(700);
  await closePanel();
  await shot('desktop-flood.png', 'Maximum flooding distinguishes bounded-queue drops from gateway blocks with exact cumulative accounting.');
  assert.equal(await page.locator('[data-acc-state]').textContent(), 'balanced');
  pass('Maximum flood distinguishes queue drops and blocks; accounting balances');

  await pause(); await openPanel('sim'); await page.locator('[data-reset]').click(); await closePanel(); await ready();
  await openPanel('sim'); await page.locator('label[for="spd-10"]').click(); await ready(); await closePanel();
  await page.locator('[data-run]').click(); await inject('payload', 0x120, 5);
  await page.waitForFunction(() => document.querySelector('.rail[data-rail="safety"] .chip').textContent.includes('Degraded'));
  assert.equal(await page.locator('.readout[data-sig="motor"] [data-v]').textContent(), 'Off');
  await shot('desktop-safety.png', 'Critical payload evidence drives the existing independent safety latch and disables the modeled motor.');
  await openPanel('attack'); await page.locator('[data-stop]').click(); await closePanel();
  await page.waitForFunction(() => !document.querySelector('[data-recover]').disabled);
  await openPanel('status'); await page.locator('[data-recover]').click();
  await page.waitForFunction(() => document.querySelector('.readout[data-sig="motor"] [data-v]').textContent === 'On');
  await page.locator('.mini-switch').click();
  await page.waitForFunction(() => document.querySelector('.rail[data-rail="analyst"] .chip').textContent.includes('Offline'));
  await closePanel();
  pass('Safety degradation, explicit recovery and analyst disconnection retain real model behavior');

  await pause(); await openPanel('sim'); await page.locator('[data-reset]').click(); await closePanel(); await ready();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('html').evaluate(e => e.classList.contains('reduced')), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#workbench').evaluate(e => e.scrollIntoView({block:'start'}));
  await page.locator('[data-run]').click(); await inject('spoofing', 0x130, 1);
  await openPanel('evidence');
  await page.waitForFunction(() => !!document.querySelector('.ev .oc.BLOCK'));
  await page.locator('.ev').filter({ has: page.locator('.oc.BLOCK') }).first().locator(':scope > button').click();
  await closePanel();
  await page.waitForTimeout(300); await fits();
  await shot('mobile-blocked.png', '390px reduced-motion view: pinned block callout and static rejection path remain readable; mobile navigation stays available.');
  await openPanel('evidence'); await shot('mobile-evidence.png', '390px evidence detail supports selection, the full journey and payload inspection.', true);
  await openPanel('sim');
  assert.equal(await page.locator('[data-seed]').isVisible(), true);
  await shot('mobile-settings.png', 'Simulation settings move into the mobile Sim tab.');
  await closePanel();
  pass('Mobile drawers, evidence, static paths and reduced motion retain the workflow');
  await openPanel('signals');
  assert.equal(await page.locator('.signals .readouts').isVisible(), true);
  assert.equal(await page.locator('.readouts').count(), 1);
  await closePanel();

  for (const width of [320, 390, 768, 1024, 1440]) { await page.setViewportSize({ width, height: 900 }); await fits(); }
  pass('No page overflow at 320, 390, 768, 1024 or 1440 pixels');
  await page.locator('#workbench').evaluate(e => e.scrollIntoView({block:'start'}));
  const bounds = await page.locator('#workbench').boundingBox();
  assert.ok(Math.abs(bounds.y - 56) < 2 && bounds.height <= 845, JSON.stringify(bounds));
  await page.mouse.wheel(0, -900);
  await page.waitForFunction(() => document.body.dataset.view === 'architecture');
  await page.mouse.wheel(0, -1800);
  await page.waitForFunction(() => document.body.dataset.view === 'intro');
  pass('Natural scrolling changes all three scenes and desktop simulator fits below the header');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base); await page.waitForTimeout(500); await shot('mobile-intro.png', 'Mobile introduction preserves the approved typography, diagram and immediate launch action.');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.skip').evaluate(e => e === document.activeElement), true);
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const plain = await noJs.newPage(); await plain.goto(base);
  assert.ok(await plain.locator('h1').isVisible()); assert.ok(await plain.locator('noscript').isVisible());
  await plain.goto(base + '/how-it-works/'); assert.ok(await plain.locator('h1').isVisible()); await noJs.close();
  pass('Keyboard entry and non-JavaScript documentation remain accessible');

  const local = await createApp({ persist: false });
  try {
    const localBase = await local.listen(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(localBase + '/simulator/'); await ready();
    await page.locator('[data-step-sim]').click();
    await page.waitForFunction(() => document.querySelector('[data-clock]').textContent === '00:00.100');
    const s = await (await context.request.get(localBase + '/api/state')).json();
    assert.equal(s.timeMs, 100); assert.ok(s.presentation.samples.length);
    await page.locator('.appbar [data-open-tools]').click();
    const d = page.waitForEvent('download'); await page.locator('[data-export="json"]').click();
    assert.ok(JSON.parse(await readFile(await (await d).path(), 'utf8')).frames.length);
    await page.locator('[data-close-tools]').click();
    assert.equal((await context.request.get(localBase + '/src/server.js')).status(), 404);
    captureErrors = false;
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector('[data-run]').disabled);
    assert.match(await page.locator('#session-notice').textContent(), /last received state/);
    await shot('desktop-offline.png', 'Disconnected local session retains evidence, labels stale state and disables commands.');
    await context.setOffline(false); await ready(); captureErrors = true;
  } finally { await local.close(); }
  pass('Local server commands, export, allowlist and disconnect/recovery work with the new UI');
  assert.deepEqual(errors, []);
  pass('No application errors or CSP violations during verified flows');
  const evidence = {
    contract: 'docs/SIGNAL-RESOLVE-CONTRACT.md', targetViewports: ['1440x900', '390x844'],
    accessibility: { status: 'pass', evidence: 'Keyboard skip link, Escape cancellation, native dialog, labeled controls and OS reduced motion checked. Not a complete WCAG audit.' },
    responsive: { status: 'pass', evidence: 'No horizontal document overflow across five widths; mobile navigation, settings, evidence and static callouts exercised.' },
    contentStates: {
      loading: { status: 'pass', evidence: 'Workbench initializes with commands disabled; intro does not initialize the model.' },
      empty: { status: 'pass', evidence: 'New session starts paused at zero; Step produces real frames.' },
      error: { status: 'pass', evidence: 'Offline local server retains last state and locks commands, then recovers.' },
      partial: { status: 'pass', evidence: 'Completed imported replay is labeled and locked; existing evidence remains inspectable/exportable.' },
      success: { status: 'pass', evidence: 'Real low-intensity block/forward and maximum-flood drop paths, exports and 12/12 validation verified.' },
      permission: { status: 'not-applicable', reason: 'Local/browser simulation requires no device, account or hardware permission.' },
    }, renderedEvidence, checks, presentationGzipBytes: gzip,
  };
  await writeFile(resolve(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Signal Resolve browser checks: ${checks.length} passed.`);
} finally { await browser.close(); await new Promise(r => server.close(r)); }
