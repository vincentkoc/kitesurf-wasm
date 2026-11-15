# Browser runtime patches

`compiled-browser-wasm.patch` applies only to the upstream commit in `upstream.json`.
The build checks that commit and accepts either a clean checkout or exactly this patch.
It refuses unrelated tracked changes. The browser provenance records the patch SHA-256.

The patch passes the engine's imported `WebAssembly.Module` to each new page and renderer
worker instead of reading and copying the raw WASM bytes for each load. workerd
supports this input and shares the compiled code through its
`extractWasmModuleContent` implementation in `src/workerd/api/worker-loader.c++`.

Only immutable code is shared. Each worker still instantiates its own module with independent
linear memory and page state. Anonymous worker creation, compatibility flags, outbound
restrictions, resource limits and CDP behavior stay unchanged.

The generated workerd configuration also sets `--no-flush-liftoff-code`. The pinned
runtime otherwise sends moderate memory pressure when creating each isolate, which can
flush baseline code from shared WASM modules and force compilation on every navigation.
This stock V8 setting retains baseline code without disabling ordinary garbage collection
or changing page isolation. Both production and fixture provenance record the setting.

The compiler is pinned to workerd 1.20260929.1. This official release includes the
V8 correction from [workerd PR #7554](https://github.com/cloudflare/workerd/pull/7554)
that honors workerd's requested atomic cppgc sweeping. The prior 1.20260911.1
runtime could replace that request with incremental/concurrent sweeping. The
build rejects an installed compiler version that differs from `upstream.json`.
This release also changes V8 and other workerd code; it is not a single-patch
experiment or, by itself, proof that the intermittent navigation timeout is fixed.

The patch also releases a page's RPC session capability after the existing one-second
close grace even if the remote close never acknowledges. Normal close-before-kill ordering
is preserved; a late acknowledgement does not dispose twice. Seven regressions cover hung
close/kill, rejected kill, immediate kill, close alone, late settlement and late session arrival.
CI runs all 28 adapter tests directly against the patched source in Node. This is a bounded
cleanup correctness fix, not evidence that the remaining native-isolate retention or RSS
growth is resolved; an in-flight remote call can retain references independently.

The production smoke checks navigation-global isolation, concurrent-tab isolation, input,
click handlers, rendering and tab closure. The corrected evaluator measures the remaining
memory growth separately; this patch is not a claim of leak-free or constant-memory browsing.
