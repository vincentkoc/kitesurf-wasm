# Browser evaluation

The original OpenClaw workflow result was not a pure engine benchmark. It included route dispatch,
Playwright actionability waits, CDP proxying, and resource traversal in the controller. Its ~1.9 GiB
Kitesurf memory result was an accumulated whole-process maximum after repeated navigations, not
the footprint of a fresh page. Keep those measurements as integration evidence, not an engine
speed ranking.

## Reproduce on Linux

Build the fixture binary using the same pinned source and workerd as the production binary:

```sh
npm run build -- --fixture
npm run eval:browser -- --engine kitesurf --binary packages/browser/bin/kitesurf-fixture --mode latency --iterations 20 --output artifacts/kitesurf-latency.json
npm run eval:browser -- --engine kitesurf --binary packages/browser/bin/kitesurf-fixture --mode lifecycle --iterations 20 --output artifacts/kitesurf-lifecycle.json
```

The fixture permits loopback only for these local HTTP tests; do not ship it as a production package.
Each invocation refuses to overwrite an existing output, starts a fresh engine process, uses a new
loopback port and profile, and cleans up its process and profile. Run invocations sequentially on a
quiet host. The lifecycle test also runs in CI with 100 iterations and retains its JSON and stderr.
On Linux, add `--max-code-mib 128` to that Kitesurf lifecycle invocation to fail when
resident executable anonymous mappings exceed 128 MiB. This is a regression guard for
repeated WASM compilation, not a total-memory budget. It reads `/proc/PID/smaps` only at
lifecycle checkpoints; latency runs do not include this sampling.

For another executable, set `--engine chromium` or `--engine lightpanda` and `--binary /absolute/path`.
Chromium must have its platform shared libraries installed. A failure to launch produces
`success: false`, a nonzero exit and diagnostic stderr; it is not an engine performance result.

To distinguish executable embedding from loading the same configuration normally:

```sh
npm run eval:browser -- --engine kitesurf --binary node_modules/@cloudflare/workerd-linux-64/bin/workerd --config build/fixture/config.capnp --mode latency --iterations 20 --output artifacts/workerd-serve-latency.json
```

This comparison uses the same local generated modules; it does not replace clean-source CI.

## What the two passes mean

- **Latency:** readiness, first navigation, repeated navigation, and same-document JS are separate.
  No resource polling runs inside either batch. Navigation ends at Puppeteer's load event; a DOM
  assertion runs after each timer. The JS batch changes an input, invokes its click handler and
  verifies the result; it does not measure physical input or OpenClaw actionability.
- **CPU:** process-tree CPU counters bracket the complete navigation batch, including the untimed
  DOM assertions. The result is a batch total, not a per-navigation median. Short-lived or exited
  descendants can be missed; this is explicitly a sampled lower bound.
- **Lifecycle:** the same process stays alive through every navigation. Each navigation records
  current RSS and PSS outside latency measurement. First-page memory, navigation growth, idle,
  page close and connection close remain distinct. Do not restart the process to hide growth.
- **Isolation:** an extra navigation verifies that a JS global does not survive. Its memory
  checkpoint is separate because it creates another document.
- **Memory:** RSS counts shared mappings repeatedly; PSS apportions them. Neither is the number
  of live WASM bytes. Boundary samples are not true peak memory.
- **Provenance:** output includes executable and fixture hashes, optional configuration hash,
  launch arguments, version response, platform and host load. Engine stderr remains attached.
  Generated configuration can reference other files: archive those build inputs for a complete
  independent reproduction.
- **Validation:** assertions fail the run; unknown metrics stay null. A single short run does
  not establish a general browser ranking or statistical speedup.

The test intentionally does not expose an inspector, force GC, suppress disposal diagnostics,
reuse mutable page isolates or enable Chromium-only fast paths.

## Loader audit, 2026-11-14

Using the existing pinned source (4a2903813a22) and workerd 1.20260911.1, ten-navigation latency
passes observed approximately 282 ms median for the embedded executable and 284 ms for
`workerd serve` of its configuration. Both grew from roughly 362–366 MiB PSS after the first page
to roughly 1,048–1,050 MiB after the batches. These were sequential diagnostic runs, not a
statistical equivalence test. They do not support blaming executable embedding for the growth.

Same-document JS was approximately 1.7–1.9 ms. It is a different operation, not a substitute
navigation benchmark. Navigation creates a fresh anonymous PageScript worker and supplies its
core WASM through WorkerLoader in upstream code. The standalone build preserves that model.

A separate inspector-only diagnostic found retired workers still present. Collecting garbage
in the engine reduced process PSS from about 1,004 MiB to 705 MiB; connection close reduced it
further to 657 MiB. That establishes some GC-sensitive retention, not an allocation-level leak
diagnosis, nor proof all remaining memory is live. Forced GC is not part of the benchmark and
must not be presented as a runtime fix.

## Compiled-module repair

The package now applies `patches/compiled-browser-wasm.patch` to the pinned source. Both
PageScript and renderer loads receive an imported `WebAssembly.Module` instead of copied raw
bytes. The pinned workerd supports this input and shares compiled code. Each anonymous worker
still creates a separate instance and memory; navigation and concurrent-tab isolation are
tested. The build records the patch digest and refuses unrelated tracked source changes.

A ten-navigation diagnostic with the corrected evaluator observed approximately 265 ms median
navigation and 540 MiB PSS after the batches, versus the preceding raw-byte build's 282 ms and
1,048 MiB. First-page PSS was approximately 271 versus 362 MiB. These are sequential local
diagnostics, not statistical speedup estimates.

This does not establish constant-memory browsing. A 100-navigation lifecycle run with the
compiled-module patch reached approximately 1,449 MiB PSS, with visible normal-GC reductions
during the run. Explicitly clearing retired session references did not improve it, so that
experiment was discarded. Testing the same patched configuration with workerd 1.20261114.1
also did not improve retention; the package keeps its original pin. The investigation below distinguishes repeated compilation from live worker ownership.
No forced GC, process recycling or mutable-isolate reuse was added.

## Shared-code flushing repair, 2026-11-15

The pinned workerd sends V8 a moderate memory-pressure notification when creating an
isolate (`src/workerd/io/worker.c++`). V8's pressure collection can flush Liftoff code
from all shared WASM modules. Compiler tracing showed the same module and functions
being compiled again on successive navigations. Retired workers disappearing did not
remove the accumulated resident executable mappings.

The generated production and fixture configurations now set the stock V8 option
`--no-flush-liftoff-code`. This prevents pressure-triggered eviction of baseline WASM
code; ordinary JavaScript/WASM garbage collection, per-page instantiation, isolation,
resource limits and cancellation remain enabled. The build records the option in its
provenance. No custom workerd binary is required.

A packaged fixture passed 100 navigations, navigation isolation and the 128 MiB
executable-anonymous-RSS guard. Resident executable anonymous memory stayed below
44 MiB, compared with approximately 890 MiB at navigation 100 in the earlier diagnostic.
The old configuration failed the new guard at navigation 8 (133.9 MiB). These mapping
measurements include anonymous executable code, not just WASM code, and are not total RSS.

In that packaged run, whole-process PSS was approximately 274 MiB at the first document,
535 MiB at navigation 100 and 482 MiB after disconnect. Normal GC produced a sawtooth
rather than monotonic growth. This fixes the observed repeated-compilation path; it does
not establish constant-memory browsing or eliminate all retention. A separate 30-navigation
local latency pass measured a 135 ms median. It is a diagnostic result, not a controlled
cross-browser ranking or statistical speedup estimate.

## Hosted comparison

CI installs Chrome for Testing 156.0.8078.47 and checksum-verified Lightpanda 1.0.2 on the same
Linux runner as the Kitesurf fixture. It executes two separate-process latency rounds in
opposite engine order, with 20 navigations and 20 same-document JS operations per invocation,
plus one 20-navigation lifecycle pass per engine. The results and stderr are retained with
the package artifacts. Downloads and dependency installation occur before measurement.

This makes a fresh comparison possible without depending on the developer host's Chromium
shared libraries. It does not make the runner dedicated or eliminate host/order noise.
Read the individual run hashes, versions and host-load observations before comparing results.
The historical OpenClaw workflow results and these direct-CDP measurements are different
workloads and must not be combined into one speedup claim.
