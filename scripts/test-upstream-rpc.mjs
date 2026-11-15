import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercise the patched upstream source itself, not a copied adapter.
// This is a Node adapter suite; browser isolation remains covered by smoke/eval.
const upstream = resolve(process.argv[2] ?? '.cache/upstream');
const temp = mkdtempSync(join(tmpdir(), 'kitesurf-rpc-tests-'));
try {
  const config = join(temp, 'vitest.config.mjs');
  writeFileSync(config, `export default ${JSON.stringify({
    root: upstream,
    cacheDir: join(temp, 'cache'),
    test: {
      environment: 'node',
      include: ['packages/engine/test/page-script-rpc-session.test.ts'],
      fileParallelism: false,
      maxWorkers: 1,
    },
  })};\n`);
  execFileSync(join(upstream, 'packages/engine/node_modules/.bin/vitest'),
    ['run', '--config', config], { cwd: upstream, stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
