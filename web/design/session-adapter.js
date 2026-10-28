// Connect the approved presentation to the existing application APIs.
// The architecture worker is isolated; navigating never resets the workbench.
export class SessionAdapter {
  constructor(post) {
    this.post = post; this.view = 'intro'; this.runtime = null; this.ready = null;
    this.busy = false; this.polling = false; this.preview = null;
    this.timer = setInterval(() => this.poll(), 250);
  }
  async init() {
    if (!this.ready) this.ready = (async () => {
      if (document.documentElement.dataset.runtime === 'browser') this.runtime = await import('/browser-runtime.js');
      const c = await this.request('/api/catalog');
      this.post({ type: 'catalog', scenarios: c.scenarios, signals: c.signals,
        intensities: c.scenarios.map(s => ({ id: s.id, levels: s.intensities })) });
    })().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async request(path, body) {
    if (this.runtime) return this.runtime.request(path, body);
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', signal: AbortSignal.timeout(path === '/api/validation' ? 120000 : 30000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  emitSnapshot(s) {
    if (this.view !== 'workbench') return;
    const p = s.presentation || {};
    const previous = this.last;
    const recentBlock = previous && previous.sessionId === s.sessionId ? Math.max(0, s.metrics.blocked - previous.metrics.blocked) : 0;
    this.last = s;
    this.post({ type: 'live', session: 'bench', ...s, ...p, catCount: { blkB: recentBlock }, samples: p.samples || s.frames });
    this.post({ type: 'frames', session: 'bench', frames: s.frames, notable: p.notable || [], events: s.events });
    this.post({ type: 'connection', online: true, source: s.source, storage: s.storage });
  }
  async poll() {
    if (this.view !== 'workbench' || !this.ready || this.polling || this.busy || document.hidden) return;
    this.polling = true;
    try { await this.init(); this.emitSnapshot(await this.request('/api/state')); }
    catch (e) { this.post({ type: 'connection', online: false, error: e.message }); }
    finally { this.polling = false; }
  }
  postMessage(msg) { void this.handle(msg); }
  async handle(msg) {
    try {
      if (msg.type === 'view') {
        this.view = msg.view;
        if (msg.view === 'architecture') {
          if (!this.preview) {
            this.preview = new Worker(new URL('./walkthrough-worker.js', import.meta.url), { type: 'module' });
            this.preview.onmessage = ({ data }) => { if (this.view === 'architecture') this.post(data); };
            this.preview.onerror = () => this.post({ type: 'connection', online: false, error: 'Architecture preview unavailable. Reload to retry.' });
          }
          this.preview.postMessage({ step: msg.step });
        } else this.preview?.postMessage({ pause: true });
        if (msg.view === 'workbench') {
          this.post({ type: 'connection', online: false, loading: true });
          await this.init(); this.emitSnapshot(await this.request('/api/state'));
        }
      } else if (msg.type === 'cmd') {
        if (this.busy) throw new Error('Please wait for the current command.');
        this.busy = true;
        await this.init();
        const s = msg.action === 'attack' ? await this.request('/api/attack', msg.attack)
          : await this.request('/api/control', { ...msg, type: undefined, id: undefined });
        this.emitSnapshot(s);
      }
      this.post({ type: 'ack', id: msg.id, ok: true });
    } catch (error) { this.post({ type: 'ack', id: msg.id, ok: false, error: error.message }); }
    finally { if (msg.type === 'cmd') this.busy = false; }
  }
  async download(format) {
    await this.init();
    if (this.runtime) return this.runtime.download(format);
    const response = await fetch(`/api/export?format=${format}`);
    if (!response.ok) throw new Error('The export could not be downloaded.');
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a'); a.href = url; a.download = `sentinel-session.${format}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
