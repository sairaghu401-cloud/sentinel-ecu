import { parentPort, workerData } from 'node:worker_threads';
import { runValidation } from './experiments.js';

try { parentPort.postMessage({ result: runValidation(workerData) }); }
catch (error) { parentPort.postMessage({ error: `Validation failed: ${error.message}` }); }
