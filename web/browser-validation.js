import { runValidation } from './engine/experiments.js';
self.onmessage = ({ data }) => {
  try { self.postMessage({ result: runValidation({ seed: data.seed }) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
