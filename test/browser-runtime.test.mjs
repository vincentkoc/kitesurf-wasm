import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { browserV8Flags, resolveBrowserRuntime } from '../scripts/browser-runtime.mjs';

test('compiler, dependency and provenance pins agree', () => {
  const root = new URL('../', import.meta.url);
  const lock = JSON.parse(readFileSync(new URL('upstream.json', root), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const deps = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  assert.equal(pkg.devDependencies.workerd, lock.workerd);
  assert.equal(deps.packages[''].devDependencies.workerd, lock.workerd);
  assert.equal(deps.packages['node_modules/workerd'].version, lock.workerd);
  assert.deepEqual(browserV8Flags, ['--no-flush-liftoff-code']);
});

test('runtime resolver rejects stale installed compilers', () => {
  const root = mkdtempSync(join(tmpdir(), 'kitesurf-runtime-test-'));
  try {
    const runtime = join(root, 'node_modules', 'workerd');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'workerd', version: '1.20260911.1' }));
    assert.equal(resolveBrowserRuntime(root, '1.20260911.1'), join(runtime, 'bin', 'workerd'));
    assert.throws(() => resolveBrowserRuntime(root, '1.20260929.1'), /workerd version mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
