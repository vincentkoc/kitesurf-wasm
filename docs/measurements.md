# Local component measurements

Measured on the development Linux x64 host, Node v26.12.1, with the WASM generated from the pinned upstream checkout. The checkout's existing generated artifacts were reused, not rebuilt from a clean toolchain for this local run. Eight interleaved A/B pairs create an independent worker, evaluate `6*7`, scan an HTML title and terminate the worker. The first shared compilation is warmed before this comparison.

| Preparation | Median wall | Median process CPU |
| --- | ---: | ---: |
| Read + compile WASM for every worker | 130.04 ms | 244.03 ms |
| Reuse immutable compiled module | 30.34 ms | 39.62 ms |

Raw samples: [core-benchmark.json](core-benchmark.json). CPU includes worker threads and can exceed wall time. Process peak RSS across **both** modes was 242,292 KiB; sequential RSS snapshots are not isolated per-mode peak-memory measurements and do not prove a memory reduction. Host load, JIT/cache state and thermal scheduling can affect these small samples.

This verifies a component-creation saving, not a full-browser speedup. No browser isolate is reused. The standalone CDP browser keeps upstream semantics and already avoids Wrangler/Node supervisory processes at runtime. Its full workload needs the independent Chromium/Lightpanda/Kitesurf comparison; do not substitute these component results for it.

The browser smoke passed its behavioral assertions. Explicit page teardown emitted workerd's `script terminated for unknown reasons` diagnostics, also observed in the original prototype. This remains an open upstream lifecycle/diagnostic limitation, not a proven leak. No runtime-error suppression was added.

## Memory attribution probe

`node --experimental-wasm-exnref scripts/probe-core-memory.mjs` measures the core separately from the workerd browser. The retained [sample](core-memory.json) shows only a few MiB of WASM linear memory at initialization and after one 800×600 render, while Node process RSS is much larger. This demonstrates that linear-memory size alone is not whole-process cost; it does not identify the cause of the earlier 1.9 GiB browser peak. Compiled code, fonts/assets, render/page isolates and allocator retention remain separate contributors to investigate. No claim of a browser memory leak or improvement is made.
