import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const out = join(root, 'artifacts');
mkdirSync(out, { recursive: true });
const sums = [];
for (const name of ['core', 'browser']) {
  const cwd = join(root, 'packages', name);
  if (!existsSync(join(cwd, 'provenance.json'))) throw new Error('Build production packages before packing');
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', out], { cwd, encoding: 'utf8' }))[0];
  const sha256 = createHash('sha256').update(readFileSync(join(out, result.filename))).digest('hex');
  sums.push(`${sha256}  ${result.filename}`);
  console.log(`${result.filename}: ${result.size} bytes; ${result.unpackedSize} unpacked`);
}
writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
