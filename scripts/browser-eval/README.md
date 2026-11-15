# Correctness-gated browser workload comparison

This suite is additive; it does not change `scripts/eval-browser.mjs` or the
single-engine lifecycle regression gate. It makes **no performance claim** until
a complete measured run has passed and been reviewed.

## Contract

- Same loopback HTTP documents, Puppeteer/CDP commands and expected values for
  Kitesurf, Chrome/Chromium and Lightpanda. No engine-specific JS/native fast path.
- Three workloads: parse/navigate a 500-row DOM; navigate/type/click/verify a
  form; navigate/execute JSON + array transformation/update/verify DOM.
- Every operation checks navigation isolation. Failure aborts the campaign and
  retains the failed JSON. The summary refuses failed, unbalanced or incomplete
  campaigns rather than treating unsupported functionality as fast execution.
- Cold: new OS process + temporary profile, first workload after page creation.
  Startup-to-CDP-readiness is recorded separately, excluded from workload time.
  Cold does **not** mean filesystem-cache cold. No OS-cache flush.
- Warm: same process, two untimed warmups, then ten fresh-document operations.
  No live document or Kitesurf isolate reuse/pooling is introduced by this runner.
- Five independent trials by default; engine order rotates per trial. All engines
  run serially on one reserved host. No profiling, builds or background browser
  jobs concurrently. Global and per-run host load are retained; inspect contention.
- Latency and resource passes use different fresh processes. Wall clock includes
  navigation, commands, serialization, assertions and harness overhead; it is not
  pure JS execution time. Resource-pass wall clock is not plotted.
- Resource pass samples `/proc` process-tree RSS/PSS every 50ms and at operation
  boundaries. RSS double-counts shared pages; PSS does not. Peak means *sampled*
  peak for the workload batch, not per-page cost or exact maximum.
- CPU sums observed self ticks per PID/start-time identity, retaining observed
  departed members. It misses unsampled exits and final increments: a lower bound,
  quantized by CLK_TCK, **not** total CPU. No % CPU headline or universal winner.
- Summary: median across trial medians for latency; median across resource-trial
  batch peaks for memory and average CPU-ms/operation lower bounds. Cold has one
  operation per trial. Min–max whiskers describe trials, not confidence intervals.
- No overall composite score or cross-workload arithmetic average. These local
  DOM/JS jobs do not qualify rendering, screenshots, visual fidelity, remote
  network behavior, site compatibility or real browsing superiority.

## Run only after reserving a measurement window

Install the repo's pinned dependencies with `npm ci --ignore-scripts`. Build and
validate the exact Kitesurf artifact separately, **before** reserving the window.
Create a local config outside public Git; values below are instructions, not data:

```json
{
  "trials": 5,
  "warmups": 2,
  "repetitions": 10,
  "engines": [
    {"id":"kitesurf", "binary":"/absolute/path/to/kitesurf", "runtimeIdentity":"workerd ACTUAL_VERSION; V8 ACTUAL_VERSION; build/flags identity", "expectedSha256":"ACTUAL_SHA256"},
    {"id":"chromium", "binary":"/absolute/path/to/chrome", "runtimeIdentity":"Chrome for Testing ACTUAL_VERSION", "expectedSha256":"ACTUAL_SHA256"},
    {"id":"lightpanda", "binary":"/absolute/path/to/lightpanda", "runtimeIdentity":"Lightpanda ACTUAL_VERSION", "expectedSha256":"ACTUAL_SHA256"}
  ]
}
```

Use actual executable version/build records and SHA-256, not `/json/version` or
user-agent compatibility strings. Kitesurf's advertised Chrome/V8 labels are not
its implementation identity. The runner records LD_LIBRARY_PATH and forces only its child TMPDIR/TMP/TEMP
to /tmp to avoid Chromium Unix-socket path limits. Record other required runtime
environment with the run.
Freeze the executable; no rebuilds between trials. No extra custom launch flags.
The fixed Chrome headless flags disable background services; `--no-sandbox` is for
these loopback-only trusted fixtures, not arbitrary browsing.

```sh
node scripts/browser-eval/run.mjs --config /absolute/config.json \
  --output /absolute/results.json --measurement-window-reserved
node scripts/browser-eval/summary.mjs /absolute/results.json /absolute/summary.json
python3 -m venv /absolute/render-venv
/absolute/render-venv/bin/pip install -r scripts/browser-eval/requirements-render.txt
EVAL_PYTHON=/absolute/render-venv/bin/python node scripts/browser-eval/chart.mjs \
  /absolute/summary.json interaction warm /absolute/interaction-warm
```

`chart.mjs` emits SVG and PNG. Repeat per workload/phase rather than combining
cold and warm. Existing files are refused. PNG uses pinned CairoSVG; retain
Python/Cairo/font versions if byte-identical rendering across hosts is required.
CairoSVG also needs native libcairo and a working font configuration; minimal
hosts may need an existing scoped LD_LIBRARY_PATH library bundle.
SVG generation is deterministic from the same summary, workload and phase.
No LLM/image generation or invented performance data is used.

Before the expensive run, declare an output directory owner, input hashes, byte
budget (suggested 20 MiB for JSON plus six SVG/PNG pairs), retention and destination.
The runner retains at most one JSON file, but does not enforce the directory budget;
check available disk and keep profiles temporary. Raw JSON contains local executable
paths and host details: review/sanitize before public publication; retain originals
privately. Black comparison panels contain only selected runtime identities,
measurements and methodology. Independently review the exact SVG/PNG before posting.

## Lightweight checks (no browser launch)

```sh
node --test test/browser-eval.test.mjs
node --check scripts/browser-eval/run.mjs
```

Tests use explicitly synthetic in-memory inputs only to exercise reducers, guards,
fixture oracles and deterministic SVG. They are not publishable benchmark results.
