# Browser WASM module sharing

`compiled-browser-wasm.patch` applies only to the upstream commit in `upstream.json`.
The build checks that commit and accepts either a clean checkout or exactly this patch.
It refuses unrelated tracked changes. The browser provenance records the patch SHA-256.

The patch passes the engine's imported `WebAssembly.Module` to each new page and renderer
worker instead of reading and copying the raw WASM bytes for each load. workerd
1.20260911.1 supports this input and shares the compiled code through its
`extractWasmModuleContent` implementation in `src/workerd/api/worker-loader.c++`.

Only immutable code is shared. Each worker still instantiates its own module with independent
linear memory and page state. Anonymous worker creation, navigation teardown, compatibility
flags, outbound restrictions, resource limits and CDP behavior stay unchanged.

The generated workerd configuration also sets `--no-flush-liftoff-code`. The pinned
runtime otherwise sends moderate memory pressure when creating each isolate, which can
flush baseline code from shared WASM modules and force compilation on every navigation.
This stock V8 setting retains baseline code without disabling ordinary garbage collection
or changing page isolation. Both production and fixture provenance record the setting.

The production smoke checks navigation-global isolation, concurrent-tab isolation, input,
click handlers, rendering and tab closure. The corrected evaluator measures the remaining
memory growth separately; this patch is not a claim of leak-free or constant-memory browsing.
