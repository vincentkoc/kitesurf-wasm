# kitesurf-wasm

Reproducible local packaging of [Cloudflare Kitesurf](https://github.com/cloudflare/kitesurf), an experimental browser engine. Unofficial; not affiliated with Cloudflare.

Two distinct artifacts:

| Package | What runs | Capabilities |
| --- | --- | --- |
| `@vincentkoc/kitesurf-core` | WASM in disposable Node worker threads | Offline HTML scan, Boa expressions, HTML-to-PNG. **Not a browser or CDP server.** |
| `@vincentkoc/kitesurf-browser-local` | Self-contained Linux x64 **workerd host with embedded WASM** | Upstream full CDP browser and per-navigation page isolation. No Node or Wrangler at runtime. **Not native-compiled Rust.** |

Nothing is published to npm automatically. CI builds downloadable package tarballs, not GitHub Releases. No built binaries or private paths are committed.

## Build

Requires Linux x64, Node 22+, npm, Corepack, Git and a working C/C++ build toolchain. The upstream Bazel build downloads its pinned toolchains and needs substantial RAM and disk space. `upstream.json`, upstream Cargo/Bazel/pnpm lockfiles, and this repository's npm lockfile pin inputs; byte-identical output across differing host toolchains is not claimed.

```sh
npm ci
corepack enable
npm run build
npm test
npm run smoke:browser
npm run pack:artifacts
```

`npm run build` obtains the exact upstream commit in `.cache/upstream`, applies the reviewed [compiled-WASM sharing patch](patches/README.md), runs its frozen pnpm install and Bazel build, bundles with Wrangler **dry-run only**, and invokes pinned workerd's compiler. Nothing is deployed to Cloudflare. A previously built checkout at the pinned commit, either clean or carrying exactly that patch, can be used explicitly:

```sh
npm run build -- --upstream /path/to/kitesurf --skip-upstream-build
```

This shortcut trusts generated files in that checkout; it is not a clean-source build verification. `artifacts/` receives both npm-format tarballs and `SHA256SUMS`. Each package carries source/runtime provenance, Apache LICENSE, upstream NOTICE, and third-party/font license texts. The browser package is platform-specific; other platforms are unqualified.

## Standalone CDP browser

```sh
./packages/browser/bin/kitesurf --experimental --socket-addr=http=127.0.0.1:18787
curl http://127.0.0.1:18787/json/version
```

Connect Puppeteer/CDP to `ws://127.0.0.1:18787/devtools/browser`. Change the final port to choose a different loopback socket. The default embedded socket also binds only loopback. workerd exposes overrides: keep the address on loopback. There is no authentication layer; this executable is a local development tool, not a public service.

The production binary uses upstream private-network checks and workerd's public-network-only outbound policy. For an explicitly opted-in local HTTP benchmark fixture only:

```sh
npm run build -- --upstream /path/to/kitesurf --skip-upstream-build --fixture
./packages/browser/bin/kitesurf-fixture --experimental --socket-addr=http=127.0.0.1:18788
```

The fixture variant permits outbound loopback and enables upstream's private-network flag. It is never packed in the production tarball. Do not use it for untrusted pages. Browser sessions are still per CDP connection and every navigation gets a new page isolate. Immutable compiled WASM code is shared, but linear memory, DOM and page globals are not.

## Python and Go

[Experimental Python and Go clients](docs/language-bindings.md) control the local
standalone browser over CDP. They are not native WASM embeddings. Source installs,
examples, deadlines, process ownership and smoke-test instructions are documented
there; no Python or Go package is published automatically.

## Node component

After building, or installing the core tarball into a project:

```js
import { createCore } from './packages/core/index.mjs';
const core = await createCore();
try {
  console.log(await core.evaluate('6 * 7')); // serialized Boa result: "42"
  console.log((await core.scan('<title>Hello</title>')).title);
  const png = await core.render('<h1>Hello</h1>', { width: 320, height: 200 });
  // png is a Uint8Array.
} finally {
  await core.close();
}
```

`compileCore()` caches one immutable compiled WebAssembly.Module promise per Node module instance. `createCore()` shares that code, **not** memory/DOM/Boa globals. Each call creates an independent worker; `close()` terminates it. Calls have a 30-second default deadline (configurable 1–120,000 ms); timeout terminates the worker. Inputs are limited to 2 MiB and render dimensions to 4096 per side.

There is no network bridge or fake successful fetch: external-resource callbacks throw. No fetch API, WorkerLoader, DOM shim, or browser globals are supplied. Render self-contained HTML only; this component is not equivalent to the full browser, and not a hardened sandbox for hostile input.

## Evidence and limitations

`npm run bench:core` compares rereading/recompiling WASM for each fresh worker with sharing its compiled module. It reports wall time, process CPU and RSS for eight interleaved pairs. This is a **Node component initialization** optimization, not evidence that CDP browsing beats Chromium or Lightpanda. See `docs/measurements.md` for the observed local result.

The full-browser smoke covers CDP, typed input, click handlers, Boa evaluation, PNG, cross-navigation and concurrent-tab global isolation, and tab teardown. Upstream/workerd currently emits `script terminated for unknown reasons` diagnostics during explicit page disposal even when these assertions pass. Logs are retained in CI; this is not a clean-error-log or production-readiness claim. The separate [browser evaluation](docs/browser-evaluation.md) records readiness, navigation, same-document JS and lifecycle memory without treating accumulated memory as a fresh-page footprint. Cross-browser results still require equivalent successful runs on a qualified host.

Upstream already enables SIMD, release optimization and LTO. This packaging does not blindly change those settings, reuse page isolates or claim an unmeasured full-browser speedup.

### Node runtime compatibility

Upstream WASM uses exception references. Node 22/24 needs `node --experimental-wasm-exnref app.mjs` when using the core API. The repository test and benchmark scripts pass this flag. Node 26.12.1 was also verified with the feature enabled by default. The standalone browser does not require Node or this flag. No WASM rewriting or unsafe host shim is used.
