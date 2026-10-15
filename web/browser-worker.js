import { BrowserSession } from './engine/browser-session.js';
const session = new BrowserSession();
self.onmessage = ({ data: { id, path, body } }) => {
  try { self.postMessage({ id, result: session.request(path, body) }); }
  catch (error) { self.postMessage({ id, error: error.message }); }
};
setInterval(() => {
  try { session.tick(); }
  catch (error) { session.sim.setRunning(false); self.postMessage({ fatal: error.message }); }
}, 50);
setInterval(() => self.postMessage({ state: session.snapshot() }), 250);
