import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, openSync, closeSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'upstream.json')));
const args = process.argv.slice(2);
const take = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--upstream') { if (!args[++i]) throw new Error('--upstream needs a path'); }
  else if (!['--skip-upstream-build', '--fixture'].includes(args[i])) throw new Error(`Unknown argument ${args[i]}`);
}
const upstream = resolve(take('--upstream') ?? join(root, '.cache/upstream'));
const run = (cmd, argv, cwd = upstream) => execFileSync(cmd, argv, { cwd, stdio: 'inherit' });
const git = argv => execFileSync('git', ['-C', upstream, ...argv], { encoding: 'utf8' }).trim();
if (!take('--upstream')) {
  mkdirSync(join(root, '.cache'), { recursive: true });
  try { git(['rev-parse', '--git-dir']); }
  catch { run('git', ['clone', '--filter=blob:none', '--no-checkout', lock.repository, upstream], root); }
  run('git', ['checkout', '--detach', lock.commit]);
}
if (git(['rev-parse', 'HEAD']) !== lock.commit || git(['status', '--porcelain', '--untracked-files=no'])) {
  throw new Error('Build requires the exact clean pinned upstream revision');
}
if (!args.includes('--skip-upstream-build')) {
  run('corepack', ['pnpm', 'install', '--frozen-lockfile']);
  run('corepack', ['pnpm', 'run', 'build']);
}
const fixture = args.includes('--fixture');
const build = join(root, 'build', fixture ? 'fixture' : 'production');
mkdirSync(build, { recursive: true });
const dist = join(build, 'dist');
run(process.execPath, ['scripts/wpt-engine.mjs', 'prepare', '--dist', dist]);
const q = JSON.stringify;
const module = (name, type, file) => `(name=${q(name)},${type}=embed ${q(relative(build, file))})`;
const engine = readdirSync(dist).filter(n => n === 'index.js' || /\.(wasm|glue\.js|css|dat)$/.test(n))
  .sort((a, b) => a === 'index.js' ? -1 : b === 'index.js' ? 1 : a.localeCompare(b))
  .map(n => module(n, n.endsWith('.wasm') ? 'wasm' : n === 'index.js' ? 'esModule' : 'text', join(dist, n)));
const publicDir = join(upstream, 'packages/engine/public');
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else if (entry.isFile()) files.push(join(dir, entry.name));
    else throw new Error(`Unexpected asset type: ${entry.name}`);
  }
}
walk(publicDir);
const types = { woff2: 'font/woff2', otf: 'font/otf', ttf: 'font/ttf', wasm: 'application/wasm', json: 'application/json', png: 'image/png', html: 'text/html', js: 'text/javascript', css: 'text/css' };
const imports = files.map((_, i) => `import a${i} from './asset-${i}';`);
const entries = files.map((file, i) => `[${q('/' + relative(publicDir, file))},[a${i},${q(types[file.split('.').at(-1)] ?? 'application/octet-stream')}]]`);
writeFileSync(join(build, 'assets.js'), `${imports.join('\n')}\nconst assets = new Map([${entries.join(',')}]);\nexport default {fetch(request) { const asset=assets.get(new URL(request.url).pathname); return asset ? new Response(asset[0], {headers:{'content-type':asset[1]}}) : new Response('not found',{status:404}); }};\n`);
const assetModules = [module('assets.js', 'esModule', join(build, 'assets.js')), ...files.map((file, i) => module(`asset-${i}`, 'data', file))];
const opts = JSON.parse(readFileSync(join(dist, 'engine-mf.json')));
// Do not embed local dev-vars or unrelated environment bindings into artifacts.
const values = {
  KITESURF_ENV: 'production', KITESURF_VERSION: lock.commit.slice(0, 12),
  KITESURF_RESOURCE_DRAIN_QUIET_TURNS: '', KITESURF_SIMULATE_PROD_EVAL: '',
  KITESURF_DISABLE_PARTIAL_RASTER: '', KITESURF_PAGE_CPU_MS_CAP: '',
  KITESURF_PAGE_WALL_MS_CAP: '', KITESURF_LAG_WATCHDOG: '',
  KITESURF_INSPECTOR_BASE_URL: '', KITESURF_INSPECTOR_FALLBACK_URL: '',
  KITESURF_ALLOW_PRIVATE_NETWORK: fixture ? '1' : '', WEB_BOT_AUTH_SIGNATURE_AGENT: '',
};
const bindings = Object.entries(values).map(([name, value]) => `(name=${q(name)},text=${q(value)})`);
bindings.push('(name="LOADER",workerLoader=())', '(name="FONT_ASSETS",service="assets")');
writeFileSync(join(build, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
 ${fixture ? '(name="internet",network=(allow=["public","127.0.0.1/32","::1/128"],tlsOptions=(trustBrowserCas=true))),' : ''}
 (name="engine",worker=(modules=[${engine.join(',\n')}],compatibilityDate=${q(lock.compatibilityDate)},compatibilityFlags=[${opts.compatibilityFlags.map(q).join(',')}],bindings=[${bindings.join(',')} ])),
 (name="assets",worker=(modules=[${assetModules.join(',\n')}],compatibilityDate=${q(lock.compatibilityDate)}))
 ], sockets=[(name="http",address="127.0.0.1:18787",http=(),service="engine")]);\n`);
const require = createRequire(join(root, 'package.json'));
const workerdPackage = require.resolve('workerd/package.json');
const workerd = join(workerdPackage, '..', 'bin/workerd');
const browser = join(root, 'packages/browser');
mkdirSync(join(browser, 'bin'), { recursive: true });
const binary = join(browser, 'bin', fixture ? 'kitesurf-fixture' : 'kitesurf');
const fd = openSync(binary, 'w', 0o755);
try { execFileSync(workerd, ['compile', join(build, 'config.capnp')], { cwd: build, stdio: ['ignore', fd, 'inherit'] }); }
finally { closeSync(fd); }
chmodSync(binary, 0o755);
const core = join(root, 'packages/core');
mkdirSync(join(core, 'vendor'), { recursive: true });
for (const name of ['kitesurf_core.js', 'kitesurf_core_bg.wasm']) cpSync(join(upstream, 'packages/core/pkg', name), join(core, 'vendor', name));
for (const target of [core, browser]) {
  for (const name of ['LICENSE', 'NOTICE', 'licenses']) cpSync(join(root, name), join(target, name), { recursive: true });
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const provenance = { ...lock, node: process.version, platform: process.platform, architecture: process.arch, fixture, binary: { file: relative(browser, binary), sha256: hash(binary) }, coreWasmSha256: hash(join(core, 'vendor/kitesurf_core_bg.wasm')) };
writeFileSync(join(browser, fixture ? 'provenance-fixture.json' : 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
writeFileSync(join(core, 'provenance.json'), JSON.stringify({ ...lock, coreWasmSha256: provenance.coreWasmSha256 }, null, 2) + '\n');
console.log(JSON.stringify(provenance, null, 2));
