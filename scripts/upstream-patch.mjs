import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function applyUpstreamPatch(upstream, commit, patchFile) {
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
      git(['apply', patchFile]);
    } else if (!matches(expected)) {
      throw new Error('Upstream has changes other than the exact reviewed package patch');
    }
    if (!matches(expected)) throw new Error('Package patch did not produce the expected upstream tree');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
