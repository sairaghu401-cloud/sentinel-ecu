import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Render the project's original vector illustration for link previews; no remote media.
const html = await readFile(new URL('../web/intro.html', import.meta.url), 'utf8');
const vehicle = html.match(/<svg viewBox="0 0 1200 420"[\s\S]*?<\/svg>/)[0];
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#f9f9f6;color:#222a2c;font-family:Arial,sans-serif}.head{padding:45px 60px 0}.brand{font-size:15px;letter-spacing:3px;color:#b54b20}h1{font-size:66px;letter-spacing:-3px;font-weight:500;line-height:1.06;margin:20px 0 0}h1 span{color:#b54b20}.caption{position:absolute;right:60px;top:115px;width:300px;font-size:19px;line-height:1.6;color:#606968}svg{display:block;width:1200px;height:350px;margin-top:8px}.hero-route{stroke:#b54b20;stroke-width:2;fill:none}.hero-module{fill:#fbfcf9;stroke:#c4ccc3}.hero-ink{fill:#58655c;font-family:monospace;font-size:9px}.hero-scan{display:none}.foot{position:absolute;bottom:25px;left:60px;right:60px;font:12px monospace;display:flex;justify-content:space-between;color:#606968}
  </style></head><body><div class="head"><div class="brand">SENTINEL ECU / VEHICLE SECURITY</div><h1>Vehicle security.<br><span>Made visible.</span></h1></div><div class="caption">A CAN security laboratory.<br>Six attack scenarios.<br>Every decision open to inspection.</div>${vehicle}<div class="foot"><span>SOFTWARE-IN-THE-LOOP</span><span>sentinel-ecu.pages.dev ↗</span></div></body></html>`);
  await writeFile(new URL('../web/social-preview.png', import.meta.url), await page.screenshot({ type: 'png' }));
} finally { await browser.close(); }
