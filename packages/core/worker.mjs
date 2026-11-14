import { parentPort, workerData } from 'node:worker_threads';
import * as core from './vendor/kitesurf_core.js';

// This is an offline component, not a replacement for the browser's network host.
core.__setBridgeFetchResource(() => {
  throw new Error('External resources are unsupported by the offline Kitesurf core API');
});
core.initSync({ module: workerData.module });
const text = value => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 2 * 1024 * 1024) {
    throw new RangeError('Expected a string of at most 2 MiB');
  }
  return value;
};
const methods = {
  ready: () => true,
  evaluate: source => core.ks_eval_sync(text(source)),
  scan: html => JSON.parse(core.ks_scan_document(text(html))),
  render: (html, url, width, height) => {
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 4096)) {
      throw new RangeError('Image dimensions must be integers in 1..4096');
    }
    return core.ks_render_html_to_image(text(html), text(url), width, height, 'png', 90);
  },
};
parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!Object.hasOwn(methods, method)) throw new Error('Unsupported core method');
    const value = methods[method](...args);
    parentPort.postMessage({ id, value });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error) });
  }
});
