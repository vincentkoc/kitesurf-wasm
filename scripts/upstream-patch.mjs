import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function restoreManagedUpstreamPatch(upstream) {
  const git = args => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim();
  const receipt = git(['rev-parse', '--path-format=absolute', '--git-path', 'kitesurf-package-patch.json']);
  if (!existsSync(receipt)) return;
  const { commit, tree } = JSON.parse(readFileSync(receipt, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree) ||
      git(['rev-parse', 'HEAD']) !== commit) throw new Error('Managed patch receipt does not match upstream');
  // Restore only a recorded package-owned patch, never operator work or staged edits.
  for (const args of [
    ['diff', '--quiet', '--no-ext-diff', '--no-textconv', tree, '--'],
    ['diff', '--cached', '--quiet', '--no-ext-diff', '--no-textconv', commit, '--'],
  ]) {
    const result = spawnSync('git', ['-C', upstream, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Managed upstream contains operator changes; preserving them');
  }
  // The staged index was verified clean above; also drop intent-to-add entries for added files.
  git(['restore', '--source=' + commit, '--staged', '--worktree', '--', '.']);
  rmSync(receipt);
}

export function applyUpstreamPatch(upstream, commit, patchFile, { managed = false } = {}) {
  const git = (args, env) => execFileSync('git', ['-C', upstream, ...args], {
    encoding: 'utf8', env,
  }).trim();
  if (git(['rev-parse', 'HEAD']) !== commit) {
    throw new Error('Build requires the exact pinned upstream revision');
  }
  const matches = tree => {
    const result = spawnSync('git', ['-C', upstream, 'diff', '--quiet', '--no-ext-diff',
      '--no-textconv', tree, '--'], { encoding: 'utf8' });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error('Cannot inspect upstream tree: ' + result.stderr);
  };
  const temp = mkdtempSync(join(tmpdir(), 'kitesurf-patch-index-'));
  try {
    // Construct the expected tree without touching the operator's real index.
    const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index') };
    git(['read-tree', commit], env);
    git(['apply', '--cached', '--check', patchFile], env);
    git(['apply', '--cached', patchFile], env);
    const expected = git(['write-tree'], env);
    if (matches(commit)) {
      git(['apply', '--check', patchFile]);
      // Record added files as intent-to-add so tree comparison and restore can see them.
      git(['apply', '--intent-to-add', patchFile]);
    } else if (!matches(expected)) {
      throw new Error('Upstream has changes other than the exact reviewed package patch');
    }
    if (!matches(expected)) throw new Error('Package patch did not produce the expected upstream tree');
    if (managed) {
      const receipt = git(['rev-parse', '--path-format=absolute', '--git-path', 'kitesurf-package-patch.json']);
      writeFileSync(receipt, JSON.stringify({ commit, tree: expected }) + '\n');
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
