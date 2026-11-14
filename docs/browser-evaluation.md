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
quiet host. The lifecycle test also runs in CI with five iterations and retains its JSON and stderr.

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

The loader/bundle configuration matches the upstream model inspected. No safe lifecycle or
module-cache fix is established by these measurements. Runtime changes need a separate
allocation/ownership investigation; sharing mutable page workers would break the tested
navigation isolation invariant.
