import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';

// Share immutable compiled code, never mutable Boa/DOM state, across disposable workers.
let compilation;
export function compileCore() {
  return compilation ??= readFile(new URL('./vendor/kitesurf_core_bg.wasm', import.meta.url))
    .then(bytes => WebAssembly.compile(bytes)).catch(error => {
      compilation = undefined;
      throw error;
    });
}

/** Component API only: no DOM shim, CDP, fetch, external resources, or browser globals. */
export async function createCore({ timeoutMs = 30_000, module } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError('timeoutMs must be 1..120000');
  }
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
    workerData: { module: module ?? await compileCore() },
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  const fail = error => {
    closed = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', () => fail(new Error('Kitesurf core worker closed')));
  worker.on('message', ({ id, value, error }) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    if (error) item.reject(new Error(error));
    else item.resolve(value);
  });
  const call = (method, args) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Kitesurf core worker closed'));
    const id = ++sequence;
    const timer = setTimeout(() => {
      fail(new Error(`Kitesurf ${method} exceeded ${timeoutMs} ms; worker terminated`));
      void worker.terminate();
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, method, args });
  });
  const api = {
    evaluate: source => call('evaluate', [source]),
    scan: html => call('scan', [html]),
    render: (html, { url = 'https://example.invalid/', width = 800, height = 600 } = {}) =>
      call('render', [html, url, width, height]),
    close: async () => {
      fail(new Error('Kitesurf core worker closed'));
      await worker.terminate();
    },
  };
  try { await call('ready', []); }
  catch (error) { await api.close(); throw error; }
  return api;
}
