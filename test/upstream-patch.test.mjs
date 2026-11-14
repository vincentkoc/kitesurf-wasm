import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyUpstreamPatch, restoreManagedUpstreamPatch } from '../scripts/upstream-patch.mjs';

test('applies only the pinned patch, is idempotent, and preserves unrelated edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitesurf-patch-'));
  const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'Fixture']);
    writeFileSync(join(dir, 'source.txt'), 'before\n');
    git(['add', 'source.txt']);
    git(['commit', '-qm', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'source.txt'), 'after\n');
    const patch = join(dir, 'reviewed.patch');
    writeFileSync(patch, git(['diff', '--binary', 'HEAD']) + '\n');
    git(['restore', 'source.txt']);
    // Diff presentation must not change source custody or execute a diff helper.
    git(['config', 'core.abbrev', '40']);
    git(['config', 'diff.noprefix', 'true']);
    git(['config', 'diff.context', '0']);
    git(['config', 'diff.algorithm', 'histogram']);
    git(['config', 'diff.external', '/nonexistent-diff-helper']);
    applyUpstreamPatch(dir, commit, patch, { managed: true });
    assert.equal(readFileSync(join(dir, 'source.txt'), 'utf8'), 'after\n');
    applyUpstreamPatch(dir, commit, patch);
    assert.throws(() => applyUpstreamPatch(dir, '0'.repeat(40), patch), /exact pinned/);
    restoreManagedUpstreamPatch(dir);
    assert.equal(readFileSync(join(dir, 'source.txt'), 'utf8'), 'before\n');
    // A new package patch can now replace the old one in the managed cache.
    writeFileSync(patch, readFileSync(patch, 'utf8').replace('+after\n', '+updated\n'));
    applyUpstreamPatch(dir, commit, patch, { managed: true });
    assert.equal(readFileSync(join(dir, 'source.txt'), 'utf8'), 'updated\n');
    writeFileSync(join(dir, 'source.txt'), 'operator change\n');
    assert.throws(() => restoreManagedUpstreamPatch(dir), /operator changes/);
    git(['add', 'source.txt']);
    assert.throws(() => restoreManagedUpstreamPatch(dir), /operator changes/);
    assert.throws(() => applyUpstreamPatch(dir, commit, patch), /other than/);
    assert.equal(readFileSync(join(dir, 'source.txt'), 'utf8'), 'operator change\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
