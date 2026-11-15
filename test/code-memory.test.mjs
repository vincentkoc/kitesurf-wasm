import assert from 'node:assert/strict';
import test from 'node:test';
import { executableAnonymousRssKiB } from '../scripts/code-memory.mjs';
import { browserV8Flags } from '../scripts/browser-runtime.mjs';

test('counts resident executable anonymous pages, not reservations or file-backed code', () => {
  const smaps = [
    '1000-2000 rwxp 00000000 00:00 0', 'Size: 1024 kB', 'Rss: 8 kB',
    '2000-3000 r-xp 00000000 08:01 2 /usr/bin/workerd', 'Rss: 64 kB',
    '3000-4000 rw-p 00000000 00:00 0 [heap]', 'Rss: 32 kB',
    '4000-5000 ---p 00000000 00:00 0', 'Rss: 0 kB',
    '5000-6000 rwxp 00000000 00:00 0 [anon:code]', 'Rss: 4 kB',
    '',
  ].join('\n');
  assert.equal(executableAnonymousRssKiB(smaps), 12);
  assert.equal(executableAnonymousRssKiB('1000-2000 rw-p 00000000 00:00 0\nRss: 4 kB\n'), 0);
  assert.throws(() => executableAnonymousRssKiB(''), /Incomplete/);
  assert.throws(() => executableAnonymousRssKiB('1000-2000 rwxp 00000000 00:00 0\n'), /Incomplete/);
  assert.throws(() => executableAnonymousRssKiB('1000-2000 rwxp 00000000 00:00 0\nRss: unknown\n'), /Invalid/);
});

test('retains shared Liftoff code without disabling GC or isolation', () => {
  assert.deepEqual(browserV8Flags, ['--no-flush-liftoff-code']);
  assert(Object.isFrozen(browserV8Flags));
});
