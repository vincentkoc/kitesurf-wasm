import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// workerd marks every new isolate under moderate memory pressure. V8 responds by
// flushing Liftoff code process-wide, including code shared with live page workers.
// Retain baseline code until its module dies; leave JS/Wasm GC and isolation intact.
export const browserV8Flags = Object.freeze(['--no-flush-liftoff-code']);

// Fail before building if the compiler differs from the version in provenance.
export function resolveBrowserRuntime(root, expectedVersion) {
  const require = createRequire(join(root, 'package.json'));
  const manifest = require.resolve('workerd/package.json');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (version !== expectedVersion) {
    throw new Error(`workerd version mismatch: expected ${expectedVersion}, installed ${version}`);
  }
  return join(dirname(manifest), 'bin', 'workerd');
}
