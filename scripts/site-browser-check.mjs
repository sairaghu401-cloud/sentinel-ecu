import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreviewServer } from './preview-site.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const out = resolve('artifacts/browser/site');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', acceptDownloads: true });
const page = await context.newPage();
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) errors.push(`Browser edition called backend: ${request.url()}`); });
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
try {
  await page.goto(`${base}/laboratory/`);
  await page.getByText('Browser simulation ready', { exact: true }).waitFor();
  const release = await (await context.request.get(`${base}/_release.json`)).json();
  assert.match(release.commit, /^(?:[a-f0-9]{40}|local)$/);
  await page.locator('#step').click();
  await page.waitForFunction(() => document.querySelector('#model-time').textContent === '00:00.100');
  const other = await context.newPage();
  await other.goto(`${base}/laboratory/`);
  await other.getByText('Browser simulation ready', { exact: true }).waitFor();
  assert.equal(await other.locator('#model-time').textContent(), '00:00.000');
  assert.equal(await other.locator('#run-state').textContent(), 'PAUSED');
  await other.close();
  pass('Built site starts real workers and isolates browser tabs');

  await page.locator('#attack-type').selectOption('payload');
  await page.locator('#attack-intensity').selectOption('1');
  assert.match(await page.locator('#intensity-effect').textContent(), /10%/);
  await page.locator('#attack-intensity').selectOption('5');
  // One press arms Inject attack; the second press confirms the injection.
  await page.locator('#inject-attack').click();
  assert.match(await page.locator('#inject-attack').textContent(), /Confirm injection/);
  await page.locator('#inject-attack').click();
  await page.waitForFunction(() => !document.querySelector('#active-attacks').hidden);
  await page.locator('#speed').selectOption('10');
  await page.locator('#toggle-run').click();
  await page.waitForFunction(() => document.querySelector('#safety-state').textContent.includes('Degraded'));
  await page.locator('#toggle-run').click();
  assert.ok(Number((await page.locator('#metric-blocked').textContent()).replaceAll(',', '')) > 0);
  await page.locator('#analyst-toggle').uncheck();
  await page.waitForFunction(() => document.querySelector('#analyst-description').textContent.includes('Offline'));
  pass('Intensity, attack filtering, safety and Pi controls work without a backend');

  await page.locator('#tab-traffic').click();
  for (const format of ['json', 'csv']) {
    const downloadPromise = page.waitForEvent('download');
    await page.locator(`a[href="/api/export?format=${format}"]`).click();
    const download = await downloadPromise;
    const content = await readFile(await download.path(), 'utf8');
    if (format === 'json') {
      const report = JSON.parse(content);
      assert.equal(report.provenance.environment.runtime, 'browser-worker');
      assert.ok(report.frames.length > 0);
    } else assert.ok(content.split('\n').length > 2);
  }
  const previousSession = await page.locator('#session-label').textContent();
  await page.locator('#trace-file').setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('invalid') });
  await page.getByText(/Import failed:/).waitFor();
  assert.equal(await page.locator('#session-label').textContent(), previousSession);
  await page.locator('#trace-file').setInputFiles(resolve('examples/normal.csv'));
  await page.waitForFunction(() => document.querySelector('#run-state').textContent === 'IMPORTED · COMPLETE');
  assert.ok(await page.locator('#toggle-run').isDisabled());
  await page.locator('#reset-import').click();
  await page.waitForFunction(() => document.querySelector('#model-time').textContent === '00:00.000');
  pass('CSV/JSON downloads and atomic trace import retain evidence');

  await page.locator('#tab-validation').click();
  await page.locator('#run-validation').click();
  await page.getByText('12 of 12 scenarios passed', { exact: true }).waitFor({ timeout: 60000 });
  await page.screenshot({ path: resolve(out, 'validation.png'), fullPage: true });
  pass('Built validation worker passes all 12 scenarios');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['overview', 'traffic', 'validation', 'guide']) {
    await page.locator(`#tab-${tab}`).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.locator('#tab-overview').click();
  await page.screenshot({ path: resolve(out, 'mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  pass('Mobile views fit and browser logs contain no errors or backend calls');
  await writeFile(resolve(out, 'checks.json'), JSON.stringify({ checks, release }, null, 2));
} catch (error) {
  await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve));
}
