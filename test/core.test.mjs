import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileCore, createCore } from '../packages/core/index.mjs';

test('cache immutable compilation; isolate mutable state and close deterministically', async () => {
  assert.equal(compileCore(), compileCore());
  const [a, b] = await Promise.all([createCore(), createCore()]);
  try {
    assert.equal(await a.evaluate('6 * 7'), '42');
    await a.evaluate('globalThis.secret = 123');
    assert.equal(await b.evaluate('typeof secret'), '"undefined"');
    assert.equal((await a.scan('<title>Component</title><h1>Hello</h1>')).title, 'Component');
    const png = await a.render('<body style="background:#258"><h1>Offline</h1>', { width: 320, height: 200 });
    assert.deepEqual(Array.from(png.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    await assert.rejects(a.render('x', { width: 0 }), /dimensions/);
    await assert.rejects(a.scan('x'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
    assert.equal(await a.evaluate('typeof fetch'), '"undefined"');
  } finally { await Promise.all([a.close(), b.close()]); }
  await assert.rejects(a.evaluate('1'), /closed/);
});

test('timed out Boa execution terminates the entire worker', async () => {
  const core = await createCore({ timeoutMs: 5_000 });
  try {
    await assert.rejects(core.evaluate('while (true) {}'), /exceeded/);
    await assert.rejects(core.scan('x'), /closed/);
  } finally { await core.close(); }
});
