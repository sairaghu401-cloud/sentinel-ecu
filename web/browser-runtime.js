const worker = new Worker(new URL('./browser-worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let sequence = 0, failed = null, listener, onFailure, validationReport = null, validationJob = null;
function fail(message) {
  failed = new Error(message);
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(failed); }
  pending.clear(); onFailure?.();
}
worker.onmessage = ({ data }) => {
  if (data.fatal) { fail(data.fatal); return; }
  if (data.state) { listener?.(data.state); return; }
  const job = pending.get(data.id);
  if (!job) return;
  clearTimeout(job.timer); pending.delete(data.id);
  if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
};
worker.onerror = () => fail('The browser simulation stopped. Reload the page to start a new session.');
worker.onmessageerror = () => fail('A simulation update could not be read. Reload the page.');

function validate(seed) {
  if (validationJob) return Promise.reject(new Error('Validation is already running.'));
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return Promise.reject(new Error('Invalid seed.'));
  return new Promise((resolve, reject) => {
    const job = new Worker(new URL('./browser-validation.js', import.meta.url), { type: 'module' });
    validationJob = job;
    const timer = setTimeout(() => finish(new Error('Validation exceeded 120 seconds. Try again with other busy tabs closed.')), 120000);
    function finish(error, result) {
      clearTimeout(timer); job.terminate(); validationJob = null;
      if (error) reject(error); else { validationReport = result; resolve(result); }
    }
    job.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
    job.onerror = () => finish(new Error('Validation worker failed. Please try again.'));
    job.postMessage({ seed });
  });
}

export function request(path, body) {
  if (failed) return Promise.reject(failed);
  if (path === '/api/validation') return body === undefined
    ? Promise.resolve({ running: Boolean(validationJob), report: validationReport }) : validate(body.seed ?? 42);
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The browser simulation took too long. Reload to start a new session.')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, path, body });
  });
}
export function subscribe(callback, errorCallback) {
  listener = callback; onFailure = errorCallback;
  if (failed) errorCallback();
  return { readyState: 1, close() { listener = null; onFailure = null; } };
}
export async function download(format) {
  const file = await request('/api/export', { format });
  const url = URL.createObjectURL(new Blob([file.content], { type: file.type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
