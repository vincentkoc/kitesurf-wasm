# @vincentkoc/kitesurf-core

Offline Kitesurf WASM components in disposable Node worker threads. This is not a browser or CDP server. Install the tarball built by [kitesurf-wasm](https://github.com/vincentkoc/kitesurf-wasm).

```js
import { createCore } from '@vincentkoc/kitesurf-core';
const core = await createCore();
try {
  console.log(await core.evaluate('6*7')); // serialized Boa result: "42"
  console.log((await core.scan('<title>Hello</title>')).title);
  const png = await core.render('<h1>Hello</h1>', { width: 320, height: 200 });
} finally {
  await core.close();
}
```

`compileCore()` caches immutable compiled code. `createCore()` never shares mutable WASM/Boa state with another worker. Close each instance explicitly. Calls have a 30-second deadline (configurable `timeoutMs`, 1–120,000 ms) and terminate the worker on timeout. Inputs must be strings of at most 2 MiB; image dimensions must be integers in 1–4096.

No network, DOM shim or browser globals are provided. External-resource callbacks throw; render self-contained markup only. This component is not a hardened hostile-code sandbox. See the source repository for browser packaging, tests and scoped measurements. Provenance and upstream/third-party licenses are included in this package.

### Node runtime compatibility

Upstream WASM uses exception references. Node 22/24 needs `node --experimental-wasm-exnref app.mjs` when using the core API. The repository test and benchmark scripts pass this flag. Node 26.12.1 was also verified with the feature enabled by default. The standalone browser does not require Node or this flag. No WASM rewriting or unsafe host shim is used.
