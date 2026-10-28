import { observePresentation, presentationSnapshot } from './presentation-observer.js';
import http from 'node:http';
import { readFile, mkdir, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { Simulation, SCENARIOS, SIGNALS, INTENSITY_PROFILES, describeAttackIntensity } from './simulation.js';
import { parseTrace, framesToCsv } from './datasets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BODY_LIMIT = 2_200_000;
const MAX_CLIENTS = 12;
const MAX_SESSIONS = 30;
const STATIC = new Map([
  ['/laboratory/', ['index.html', 'text/html; charset=utf-8']],
  ['/laboratory', ['index.html', 'text/html; charset=utf-8']],
  ...['sentinel.js', 'session-adapter.js', 'walkthrough-worker.js'].map(file => [`/design/${file}`, [`design/${file}`, 'text/javascript; charset=utf-8']]),
  ...['sentinel.css', 'production.css'].map(file => [`/design/${file}`, [`design/${file}`, 'text/css; charset=utf-8']]),
  ...['archivo-var.woff2', 'ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-latin-500-normal.woff2', 'ibm-plex-mono-latin-600-normal.woff2'].map(file => [`/design/fonts/${file}`, [`design/fonts/${file}`, 'font/woff2']]),
  ['/', ['signal.html', 'text/html; charset=utf-8']],
  ['/index.html', ['signal.html', 'text/html; charset=utf-8']],
  ['/simulator/', ['signal.html', 'text/html; charset=utf-8']],
  ['/simulator', ['signal.html', 'text/html; charset=utf-8']],
  ...['how-it-works', 'attack-scenarios', 'validation'].flatMap(slug => [
    [`/${slug}/`, [`${slug}.html`, 'text/html; charset=utf-8']],
    [`/${slug}`, [`${slug}.html`, 'text/html; charset=utf-8']],
  ]),
  ['/public.css', ['public.css', 'text/css; charset=utf-8']],
  ['/presentation.css', ['presentation.css', 'text/css; charset=utf-8']],
  ['/public.js', ['public.js', 'text/javascript; charset=utf-8']],
  ['/social-preview.png', ['social-preview.png', 'image/png']],
  ['/sitemap.xml', ['sitemap.xml', 'application/xml; charset=utf-8']],
  ['/robots.txt', ['robots.txt', 'text/plain; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/workbench.css', ['workbench.css', 'text/css; charset=utf-8']],
  ['/vendor/tabler.min.css', ['vendor/tabler.min.css', 'text/css; charset=utf-8']],
  ['/vendor/theme.css', ['vendor/theme.css', 'text/css; charset=utf-8']],
  ['/vendor/barlow-regular.ttf', ['vendor/barlow-regular.ttf', 'font/ttf']],
  ['/vendor/barlow-semibold.ttf', ['vendor/barlow-semibold.ttf', 'font/ttf']],
  ['/vendor/barlow-condensed-semibold.ttf', ['vendor/barlow-condensed-semibold.ttf', 'font/ttf']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, 'Send a JSON request with Content-Type: application/json.');
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw new HttpError(413, 'Request exceeds the 2 MB trace limit.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'Request exceeds the 2 MB trace limit.');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Request must be a JSON object.');
  return value;
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, `${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new HttpError(400, `${name} must be true or false.`);
  return value;
}

function newSession(source = 'synthetic') {
  return { id: randomUUID(), createdAt: new Date().toISOString(), source };
}

/** Local application factory, exported so HTTP behavior is integration-testable. */
export async function createApp({ dataDir = join(ROOT, 'data'), persist = true } = {}) {
  let sim = observePresentation(new Simulation({ seed: 42, profile: 'urban' }));
  let session = newSession();
  let provenance = {};
  let storageError = null;
  let persistence = Promise.resolve();
  let clock = null;
  let pushTimer = null;
  let saveTimer = null;
  let validationWorker = null;
  let closed = false;
  let validationReport = null;
  const clients = new Set();

  if (persist) {
    try { await mkdir(dataDir, { recursive: true }); }
    catch (error) { storageError = `Session storage unavailable: ${error.message}`; }
  }

  function snapshot() {
    const state = sim.snapshot();
    // UI receives a small window; exports retain the engine's complete bounded buffer.
    return { ...state, presentation: presentationSnapshot(sim), frames: state.frames.slice(0, 150), events: state.events.slice(0, 60),
      sessionId: session.id, source: session.source,
      storage: { enabled: persist && !storageError, path: persist ? dataDir : null, error: storageError } };
  }

  function fullReport() {
    const engineReport = sim.report();
    return {
      ...engineReport,
      schemaVersion: 1,
      session: { ...session },
      exportedAt: new Date().toISOString(),
      snapshot: sim.snapshot(),
      frames: sim.getFrames(),
      provenance: {
        ...engineReport.provenance, kind: session.source, ...provenance,
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        timing: 'Host processing is measured with a monotonic clock. CAN serialization, queueing and safety acknowledgment are modeled; no MCU or RTOS timing is measured.',
        scope: 'Local software-in-the-loop laboratory. Synthetic CAN IDs and payload schema. No physical CAN, actuator, cryptographic identity or vehicle certification.',
        retention: 'Counters cover the entire run. Frames and events are bounded recent windows; inspect snapshot.limits before treating exports as complete traces.',
      },
    };
  }

  async function persistReport(report) {
    if (!persist) return;
    try {
      await mkdir(dataDir, { recursive: true });
      const file = join(dataDir, `${report.session.id}.json`);
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify(report), 'utf8');
      await rename(temp, file);
      const entries = await readSessions();
      for (const entry of entries.slice(MAX_SESSIONS)) await rm(join(dataDir, `${entry.id}.json`));
      storageError = null;
    } catch (error) { storageError = `Session could not be saved: ${error.message}`; }
  }

  function save() {
    if (!persist || closed) return persistence;
    const report = fullReport();
    // Serial writes prevent temp-file races and preserve reset/shutdown ordering.
    persistence = persistence.then(() => persistReport(report));
    return persistence;
  }

  async function readSessions() {
    if (!persist) return [];
    let files;
    try { files = await readdir(dataDir); } catch { return []; }
    const sessions = await Promise.all(files.filter(f => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(f)).map(async file => {
      try {
        const report = JSON.parse(await readFile(join(dataDir, file), 'utf8'));
        const s = report.snapshot;
        if (typeof report.session?.createdAt !== 'string' || !Number.isFinite(Date.parse(report.session.createdAt)) || !s?.metrics) return null;
        // Never derive cleanup paths from editable report contents.
        return { id: file.slice(0, -5), createdAt: report.session.createdAt, source: report.session.source,
          profile: s.profile, seed: s.seed, timeMs: s.timeMs, received: s.metrics.received,
          blocked: s.metrics.blocked, status: s.status };
      } catch { return null; }
    }));
    return sessions.filter(Boolean).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }

  function push() {
    if (!clients.size) return;
    const payload = `event: state\ndata: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) {
      if (res.destroyed || res.writableLength > 1_000_000) { clients.delete(res); res.destroy(); continue; }
      res.write(payload);
    }
  }

  async function runValidation(seed) {
    if (validationWorker) throw new HttpError(409, 'Validation is already running. Wait for it to finish.');
    return new Promise((resolveJob, rejectJob) => {
      const worker = new Worker(new URL('./validation-worker.js', import.meta.url), { workerData: { seed } });
      validationWorker = worker;
      let settled = false;
      const timeout = setTimeout(() => finish(new HttpError(503, 'Validation exceeded its 60 second time limit.')), 60_000);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (validationWorker === worker) validationWorker = null;
        void worker.terminate();
        if (error) rejectJob(error); else { validationReport = result; resolveJob(result); }
      }
      worker.once('message', msg => msg.error ? finish(new HttpError(500, msg.error)) : finish(null, msg.result));
      worker.once('error', error => finish(error));
      worker.once('exit', code => { if (!settled) finish(new HttpError(503, `Validation worker exited before completion (${code}).`)); });
    });
  }

  const server = http.createServer({ maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'This laboratory accepts requests through its local address only.');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin requests are not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed.');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', version: '1.0.0' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot());
      if (req.method === 'GET' && url.pathname === '/api/catalog') return json(res, 200, { scenarios: SCENARIOS.map(scenario => ({ ...scenario, intensities: INTENSITY_PROFILES.map(profile => describeAttackIntensity(scenario.id, profile.level)) })), signals: SIGNALS });
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, { sessions: (await readSessions()).slice(0, MAX_SESSIONS) });
      if (req.method === 'GET' && url.pathname === '/api/validation') return json(res, 200, { running: !!validationWorker, report: validationReport });
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (clients.size >= MAX_CLIENTS) throw new HttpError(503, 'Live-view client limit reached. Close another laboratory tab.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        res.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const format = url.searchParams.get('format') || 'json';
        if (!['json', 'csv'].includes(format)) throw new HttpError(400, 'Export format must be json or csv.');
        const content = format === 'json' ? JSON.stringify(fullReport(), null, 2) : framesToCsv(sim.getFrames());
        res.writeHead(200, { 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="sentinel-${session.id}.${format}"`, 'Cache-Control': 'no-store' });
        res.end(content); return;
      }
      if (req.method === 'POST') {
        if (!['/api/control','/api/attack','/api/validation','/api/import'].includes(url.pathname)) throw new HttpError(404, 'API endpoint not found.');
        const input = await body(req);
        if (url.pathname === '/api/control') {
          switch (input.action) {
            case 'start':
              if (session.source === 'imported') throw new HttpError(409, 'This is a completed imported trace. Reset to a synthetic session before running.');
              sim.setRunning(true); break;
            case 'pause': sim.setRunning(false); break;
            case 'step':
              if (session.source === 'imported') throw new HttpError(409, 'Reset before stepping an imported session.');
              if (sim.running) throw new HttpError(409, 'Pause the simulation before stepping.');
              sim.advance(integer(input.milliseconds ?? 100, 1, 10000, 'Step duration')); break;
            case 'speed':
              if (![0.5,1,2,5,10].includes(input.speed)) throw new HttpError(400, 'Speed must be 0.5, 1, 2, 5 or 10.');
              sim.setSpeed(input.speed); break;
            case 'analyst': sim.setAnalyst(requireBoolean(input.connected, 'Analyst connection')); break;
            case 'clear-attacks': sim.clearAttacks(); break;
            case 'recover': {
              if (!sim.safety.recoveryEligible) throw new HttpError(409, 'Recovery is not yet eligible. Clear attacks and run through the quiet interval first.');
              sim.requestRecovery(); break;
            }
            case 'reset': {
              const seed = integer(input.seed ?? 42, 0, 0xffffffff, 'Seed');
              const profile = input.profile ?? 'urban';
              if (!['urban', 'highway'].includes(profile)) throw new HttpError(400, 'Profile must be urban or highway.');
              const next = observePresentation(new Simulation({ seed, profile }));
              void save(); sim = next; session = newSession(); provenance = {}; break;
            }
            default: throw new HttpError(400, 'Unknown simulation action.');
          }
          push(); return json(res, 200, snapshot());
        }
        if (url.pathname === '/api/attack') {
          if (session.source === 'imported') throw new HttpError(409, 'Reset to a synthetic session before injecting an attack.');
          sim.injectAttack(input); push(); return json(res, 200, snapshot());
        }
        if (url.pathname === '/api/validation') return json(res, 200, await runValidation(integer(input.seed ?? 42, 0, 0xffffffff, 'Seed')));
        if (url.pathname === '/api/import') {
          if (typeof input.text !== 'string') throw new HttpError(400, 'Trace text is required.');
          let parsed;
          try { parsed = parseTrace(input.text, input.format); }
          catch (error) { throw new HttpError(400, error.message); }
          const next = observePresentation(new Simulation({ seed: 42, profile: 'urban' }));
          for (const frame of parsed.frames) next.ingest(frame);
          next.advance(500);
          next.setRunning(false);
          void save(); sim = next; session = newSession('imported');
          provenance = { format: parsed.format, rows: parsed.frames.length, warnings: parsed.warnings };
          const summary = { frames: parsed.frames.length, format: parsed.format, warnings: parsed.warnings,
            note: 'Evaluated against the built-in synthetic vehicle schema; external vehicles require their own ID/payload rules.' };
          push(); void save(); return json(res, 200, { summary, snapshot: snapshot() });
        }
      }
      if (req.method === 'GET' && ['/engine/simulation.js', '/engine/presentation-observer.js'].includes(url.pathname)) {
        const content = await readFile(join(ROOT, 'src', url.pathname.split('/').pop()));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(content); return;
      }
      if (req.method === 'GET' && STATIC.has(url.pathname)) {
        const [file, type] = STATIC.get(url.pathname);
        const content = await readFile(join(ROOT, 'web', file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(content); return;
      }
      throw new HttpError(req.method === 'GET' ? 404 : 405, req.method === 'GET' ? 'Resource not found.' : 'Method not allowed.');
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error.status || (error instanceof TypeError || error instanceof RangeError ? 400 : 500);
      if (status >= 500) console.error(JSON.stringify({ event: 'request_error', message: error.message }));
      json(res, status, { error: status === 500 ? 'The request could not be completed. See the local server log.' : error.message });
    }
  });

  server.keepAliveTimeout = 5000;
  server.maxConnections = 40;
  return {
    server,
    snapshot,
    async listen(port = 8787) {
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolveListen(); });
      });
      clock = setInterval(() => {
        // Read the engine's fields directly; a full snapshot copies the frame, event and series buffers.
        try { if (sim.running) sim.advance(Math.round(50 * sim.speed)); }
        catch (error) { sim.setRunning(false); console.error(JSON.stringify({ event: 'simulation_paused', message: error.message })); }
      }, 50);
      pushTimer = setInterval(push, 250);
      saveTimer = setInterval(() => { void save(); }, 10_000);
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (closed) return;
      clearInterval(clock); clearInterval(pushTimer); clearInterval(saveTimer);
      sim.setRunning(false);
      await save(); closed = true;
      if (validationWorker) await validationWorker.terminate();
      for (const res of clients) res.end(); clients.clear();
      const closing = new Promise(resolveClose => server.close(resolveClose));
      server.closeAllConnections();
      await closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT must be an integer from 1 to 65535.'); process.exit(1); }
  const app = await createApp();
  try { console.log(`Sentinel ECU laboratory ready at ${await app.listen(port)}\nPress Ctrl+C to save and stop.`); }
  catch (error) { console.error(`Could not start: ${error.message}`); process.exit(1); }
  let shuttingDown = false;
  const shutdown = async () => { if (shuttingDown) return; shuttingDown = true; await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
