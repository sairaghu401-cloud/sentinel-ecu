import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../src/server.js';

// Optional development check; the simulator itself has no browser-test dependency.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'artifacts', 'browser');
await mkdir(out, { recursive: true });
let app = await createApp({ persist: false });
const base = await app.listen(0);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage();
const runtimeErrors = [];
let captureErrors = true;
page.on('pageerror', error => runtimeErrors.push(error.message));
page.on('console', message => { if (captureErrors && message.type() === 'error') runtimeErrors.push(message.text()); });
const checks = [];
const artifacts = [];
function passed(name) { checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function state() { return (await context.request.get(`${base}/api/state`)).json(); }
async function control(input) {
  const res = await context.request.post(`${base}/api/control`, { data: input });
  assert.equal(res.status(), 200, await res.text()); return res.json();
}
async function shot(name, observation) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(out, name), fullPage: true });
  const v = page.viewportSize();
  artifacts.push({ viewport: `${v.width}x${v.height}`, artifact: name, observation });
}
async function noPageOverflow() {
  const bounds = await page.evaluate(() => ({ body: document.documentElement.scrollWidth, view: innerWidth }));
  assert.ok(bounds.body <= bounds.view + 1, `Page overflow: ${JSON.stringify(bounds)}`);
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#connection-state').textContent.includes('Server connected'));
  assert.equal((await state()).running, false);
  assert.ok(await page.locator('#chart-empty').isVisible());
  await noPageOverflow();
  await shot('desktop-ready.png', 'Fresh paused laboratory: empty traffic, working controls and visible simulation scope at 1440x900.');
  passed('Initial connection and empty state');

  await page.locator('#attack-type').selectOption('flooding');
  await page.locator('#attack-intensity').selectOption('1');
  assert.match(await page.locator('#intensity-effect').textContent(), /^100 extra frames\/s/);
  await page.locator('#inject-attack').click();
  await page.waitForFunction(() => document.querySelector('#active-attacks').textContent.includes('Low · 1/5'));
  await page.locator('#attack-intensity').selectOption('5');
  assert.match(await page.locator('#intensity-effect').textContent(), /15,000 extra frames\/s/);
  assert.match(await page.locator('#active-attacks').textContent(), /Low · 1\/5/);
  await page.locator('#clear-attacks').click();
  await page.locator('#attack-type').selectOption('payload');
  await page.locator('#attack-intensity').selectOption('1');
  assert.match(await page.locator('#intensity-effect').textContent(), /10% of target frames/);
  await shot('desktop-low-intensity.png', 'Low intensity preview explains the actual corrupted-frame fraction; active scenarios retain their submitted level when the selector changes.');
  await page.locator('#attack-intensity').selectOption('2');
  await page.locator('#attack-type').selectOption('spoofing');
  passed('Intensity previews describe each scenario and preserve submitted attack strength');

  for (const signal of ['288', '304', '512', '768']) {
    await page.locator(`[data-signal="${signal}"]`).click();
    assert.equal(await page.locator('#attack-target').inputValue(), signal);
    assert.equal(await page.locator(`[data-signal="${signal}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-signal][aria-pressed="true"]').count(), 1);
  }
  await page.locator('#attack-target').selectOption('1024');
  assert.equal(await page.locator('[data-signal][aria-pressed="true"]').count(), 0);
  assert.match(await page.locator('#selected-signal').textContent(), /0x400/);
  await page.locator('[data-signal="288"]').click();
  await page.locator('.architecture-details summary').click();
  assert.ok(await page.locator('.topology').isVisible());
  await page.locator('.architecture-details summary').click();
  passed('Vehicle hotspots use real CAN IDs and sync with the attack selector');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#toggle-run').click();
  await page.waitForFunction(() => document.querySelector('#network-visual').classList.contains('running'));
  assert.equal(await page.locator('.signal-packets').evaluate(el => getComputedStyle(el).animationName), 'signal-packets');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.signal-packets').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.locator('#toggle-run').click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.locator('.signal-packets').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#reset').click();
  await page.waitForFunction(() => document.querySelector('#model-time').textContent === '00:00.000');
  passed('Packet motion follows run/pause and respects reduced motion');

  await page.locator('#tab-overview').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#tab-traffic').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#tab-traffic').evaluate(el => el === document.activeElement), true);
  const outline = await page.locator('#tab-traffic').evaluate(el => getComputedStyle(el).outlineWidth);
  assert.notEqual(outline, '0px');
  await page.keyboard.press('Home');
  passed('Keyboard tab navigation and visible focus');

  await page.locator('#step').click();
  await page.waitForFunction(() => document.querySelector('#model-time').textContent === '00:00.100');
  assert.ok((await state()).metrics.received > 0);
  await page.locator('#speed').selectOption('5');
  await page.locator('#toggle-run').click();
  await page.waitForFunction(() => Number(document.querySelector('#metric-received').textContent.replaceAll(',', '')) > 350);
  await page.locator('#toggle-run').click();
  const paused = await state();
  assert.equal(paused.running, false);
  assert.ok(paused.metrics.forwarded > 0);
  await shot('desktop-normal.png', 'Clean seeded traffic and live chart with actual engine counters.');
  passed('Step, speed, run and pause controls');

  await page.locator('#attack-type').selectOption('flooding');
  await page.locator('#attack-target').selectOption('768');
  await page.locator('#attack-duration').selectOption('30000');
  await page.locator('#attack-intensity').selectOption('5');
  await page.locator('#inject-attack').click();
  await control({ action: 'step', milliseconds: 10000 });
  await page.waitForFunction(() => document.querySelector('#gateway-assessment').textContent === 'Threat detected · filtering');
  assert.equal(await page.locator('#safety-state').textContent(), 'Shutdown not requested');
  assert.match(await page.locator('#safety-reason').textContent(), /recent brake, steering or powertrain evidence/);
  assert.match(await page.locator('#analyst-assessment').textContent(), /no active payload hold/);
  assert.match(await page.locator('#analyst-evidence').textContent(), /0 outliers this session/);
  await shot('desktop-battery-flood.png', 'Maximum battery flood: gateway filtering, Pi payload monitoring without outliers, and explicit missing critical-signal safety criterion.');
  await page.locator('.resilience-panel').screenshot({ path: resolve(out, 'battery-flood-status.png') });
  passed('Battery flood distinguishes gateway filtering, Pi payload assessment and vehicle safety');
  await page.locator('#reset').click();
  await page.waitForFunction(() => document.querySelector('#model-time').textContent === '00:00.000');
  await page.locator('#attack-target').selectOption('288');
  await page.locator('#attack-intensity').selectOption('2');

  await page.locator('#attack-type').selectOption('payload');
  await page.locator('#attack-duration').selectOption('3000');
  await page.locator('#inject-attack').click();
  await page.waitForFunction(() => !document.querySelector('#active-attacks').hidden);
  await control({ action: 'step', milliseconds: 1500 });
  await page.waitForFunction(() => document.querySelector('#safety-state').textContent.includes('Degraded'));
  assert.ok((await state()).metrics.blocked > 0);
  assert.equal((await state()).safety.state, 'DEGRADED');
  await page.locator('#analyst-toggle').uncheck();
  await page.waitForFunction(() => document.querySelector('#analyst-description').textContent.includes('Offline'));
  await shot('desktop-attack.png', 'Critical payload attack filtered, degradation latched, and analyst disconnected with gateway rules active.');
  passed('Attack, safety acknowledgment and analyst loss');

  await page.locator('#clear-attacks').click();
  await control({ action: 'step', milliseconds: 6000 });
  await page.waitForFunction(() => !document.querySelector('#recover').disabled);
  await page.locator('#recover').click();
  await page.waitForFunction(() => document.querySelector('#safety-state').textContent === 'Shutdown not requested');
  passed('Clear attacks, quiet interval and explicit safety recovery');

  await page.locator('#tab-traffic').click();
  await page.locator('#frame-search').fill('0x120');
  await page.waitForFunction(() => document.querySelectorAll('#frames-body tr').length > 0);
  await page.locator('#frames-body tr').first().click();
  assert.ok(await page.locator('#frame-detail').isVisible());
  assert.match(await page.locator('#frame-detail-title').textContent(), /0x120/);
  const jsonDownload = page.waitForEvent('download');
  await page.locator('a[href="/api/export?format=json"]').click();
  assert.match((await jsonDownload).suggestedFilename(), /^sentinel-.*\.json$/);
  passed('Traffic filtering, evidence selection and report download');

  captureErrors = false; // The intentional invalid import returns HTTP400.
  const beforeImport = (await state()).sessionId;
  await page.locator('#trace-file').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('timestamp_ms,id,data,label\n0,0xFFFF,AA,attack') });
  await page.waitForFunction(() => document.querySelector('#notification-text').textContent.includes('Import failed'));
  assert.equal((await state()).sessionId, beforeImport);
  await page.locator('#trace-file').setInputFiles({ name: 'trace.csv', mimeType: 'text/csv', buffer: Buffer.from('timestamp_ms,id,data,label\n0,0x777,AA,attack\n10,0x777,BB,attack') });
  await page.waitForFunction(() => document.querySelector('#notification-text').textContent.includes('Imported trace.csv'));
  assert.equal((await state()).source, 'imported');
  assert.equal((await state()).metrics.received, 2);
  assert.ok(await page.locator('#toggle-run').isDisabled());
  assert.ok(await page.locator('#step').isDisabled());
  passed('Invalid import rollback and completed trace replay');
  captureErrors = true;

  await page.locator('#profile').selectOption('highway');
  await page.locator('#seed').fill('71');
  await page.locator('#reset').click();
  await page.waitForFunction(() => document.querySelector('#model-time').textContent === '00:00.000' && !document.querySelector('#toggle-run').disabled);
  assert.equal((await state()).profile, 'highway');
  assert.equal((await state()).seed, 71);
  passed('Profile and seed apply on reset');

  await page.locator('#tab-validation').click();
  await page.locator('#run-validation').click();
  await page.locator('#validation-progress').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#validation-results').hidden, { timeout: 60_000 });
  const summary = await page.locator('#validation-summary-title').textContent();
  assert.match(summary, /12 of 12/);
  await shot('desktop-validation.png', 'All12 synthetic validation cases shown with detector and baseline metrics and explicit limits.');
  const download = page.waitForEvent('download');
  await page.locator('#download-validation').click();
  assert.match((await download).suggestedFilename(), /validation/);
  passed('Validation pending/result states and downloadable experiment evidence');

  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of ['overview', 'traffic', 'validation', 'guide']) {
      await page.locator(`#tab-${tab}`).click();
      await noPageOverflow();
    }
    await page.locator('#tab-overview').click();
    await shot(`overview-${width}.png`, `Additional layout check at ${width}px, all four views checked for page overflow.`);
  }
  passed('Small phone, tablet, and compact desktop layouts');

  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['overview', 'traffic', 'validation', 'guide']) {
    await page.locator(`#tab-${tab}`).click();
    await noPageOverflow();
  }
  await page.locator('#tab-overview').click();
  await shot('mobile-ready.png', '390x844 layout: navigation and controls remain usable; all four tabs checked for page overflow.');
  const motion = await page.locator('.packet-flow').evaluate(el => getComputedStyle(el).animationDuration);
  assert.ok(motion === '0s' || motion.split(',').every(v => parseFloat(v) <= .001));
  passed('Four narrow layouts and reduced-motion preference');

  captureErrors = false;
  await app.close();
  await page.waitForFunction(() => !document.querySelector('#connection-banner').hidden, { timeout: 15000 });
  assert.ok(await page.locator('#toggle-run').isDisabled());
  await shot('mobile-offline.png', 'Disconnected server displays a recovery action and disables simulation commands.');
  await page.locator('#reconnect').click();
  app = await createApp({ persist: false });
  await app.listen(Number(new URL(base).port));
  await page.waitForFunction(() => document.querySelector('#connection-banner').hidden);
  passed('Connection loss and recovery');
  captureErrors = true;

  assert.deepEqual(runtimeErrors, []);
  passed('No unexpected browser runtime or console errors');
  const evidence = {
    contract: 'docs/DESIGN.md: Tabler and Amber Minimal vehicle workbench, model-linked motion, actionable simulation controls and evidence; targets1440x900 and390x844.',
    targetViewports: ['1440x900', '390x844'],
    accessibility: { status: 'pass', evidence: 'Keyboard tab navigation, selected-tab focus, visible focus outline, labelled controls and reduced-motion preference exercised. Manual screenshot review complements these checks; this is not a full WCAG audit.' },
    responsive: { status: 'pass', evidence: 'All four tabs at390x844 have no document-level horizontal overflow; desktop screenshot and mobile screenshots retained for visual inspection.' },
    contentStates: {
      loading: { status: 'pass', evidence: 'Validation progress is visible while worker runs and transitions to results.' },
      empty: { status: 'pass', evidence: 'Fresh paused state shows zero traffic with a visible Run simulation action.' },
      error: { status: 'pass', evidence: 'Invalid trace yields an actionable import error and preserves the previous session; offline server state disables commands and reconnect succeeds.' },
      partial: { status: 'pass', evidence: 'Analyst disconnected state remains visible while local gateway protection and safety controls operate.' },
      success: { status: 'pass', evidence: 'Attack/filter/degrade/recovery, import, reset, validation and export paths completed against the real engine.' },
      permission: { status: 'not-applicable', reason: 'The local application has no account roles or permission dialog; origin rejection is separately covered by HTTP tests.' },
    },
    renderedEvidence: artifacts,
    checks,
  };
  await writeFile(resolve(out, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Browser evidence saved to ${out}`);
} finally { await context.close(); await browser.close(); await app.close(); }
