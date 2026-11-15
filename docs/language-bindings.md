# Python and Go browser clients

These experimental synchronous clients control **the standalone local browser over
CDP**. They do not load the core WASM module into Python or Go and do not replace
`@vincentkoc/kitesurf-core`. The browser executable is a separate prerequisite,
currently qualified only on Linux x64. Both clients are source-installable; neither
has been published to a package registry.

Use only trusted local pages. The unauthenticated CDP port stays on loopback;
these clients intentionally reject non-loopback and authenticated endpoints.
The Python client also refuses HTTP redirects during the WebSocket handshake.
Do not expose the browser port through a public proxy or use the fixture binary
for untrusted pages. See the root README for production/fixture differences.

## Python 3.10+

From this repository (prefer a virtual environment):

```sh
python3 -m venv .venv
.venv/bin/pip install ./bindings/python
```

```python
from kitesurf_browser import Browser
from urllib.parse import quote

with Browser.launch("/absolute/path/to/kitesurf", port=18787, timeout=30) as browser:
    with browser.new_page() as page:
        page.navigate("data:text/html," + quote("<title>Hello</title><h1>Hello</h1>"))
        print(page.evaluate("document.title"))
        with open("page.png", "wb") as output:
            output.write(page.screenshot())
```

To attach without owning a process, use
`Browser.connect("ws://127.0.0.1:18787/devtools/browser", timeout=30)`.
`browser.command(method, params)` and `page.command(method, params)` expose raw
CDP when needed. `CDPError.error` preserves the protocol error object.
JavaScript exceptions raise `RuntimeError`. Evaluation returns JSON-compatible
by-value results; JavaScript `undefined` and missing/non-JSON values return `None`.
It does not automatically await promises or create remote object handles.

## Go 1.22+

Until these sources are landed, use a local module replacement in your application:

```sh
go mod edit -require=github.com/vincentkoc/kitesurf-wasm/bindings/go@v0.0.0
go mod edit -replace=github.com/vincentkoc/kitesurf-wasm/bindings/go=/absolute/path/to/kitesurf-wasm/bindings/go
go mod tidy
```

```go
package main

import (
    "context"
    "fmt"
    "log"
    "time"

    kitesurf "github.com/vincentkoc/kitesurf-wasm/bindings/go"
)

func main() {
    if err := run(); err != nil {
        log.Fatal(err) // run's deferred cleanup has already finished.
    }
}

func run() error {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    browser, err := kitesurf.Launch(ctx, "/absolute/path/to/kitesurf", 18787, 10*time.Second)
    if err != nil { return err }
    defer browser.Close()
    page, err := browser.NewPage(ctx)
    if err != nil { return err }
    defer page.Close(context.Background())
    if err := page.Navigate(ctx, "data:text/html,<title>Hello</title>"); err != nil { return err }
    var title string
    if err := page.Evaluate(ctx, "document.title", &title); err != nil { return err }
    fmt.Println(title)
    return nil
}
```

Use `Connect(ctx, endpoint, timeout)` for an existing server. Raw
`browser.Command(ctx, sessionID, method, params, &result)` uses an empty session ID
for browser-level commands. `page.Command` supplies its flattened session ID.
`errors.As(err, &cdpError)` exposes `*kitesurf.CDPError` with the protocol code,
message and optional data. Evaluation decodes a JSON value into the supplied
pointer, reports JavaScript exceptions and rejects values with no JSON
representation. It does not automatically await promises.

## Lifecycle and deadlines

- Always close pages and the browser. Closing an attached client disconnects
  only; closing a launched client also terminates and reaps its own direct child.
  Neither sends `Browser.close` to an externally owned server. Python allows
  two seconds after termination before killing the child; Go kills and reaps
  the direct child immediately.
- Python disconnects by immediately shutting down the transport, without waiting
  for a WebSocket close handshake that a trickling peer could prolong.
- Python connection setup uses an absolute deadline across TCP attempts and the
  HTTP handshake. A timer aborts partial-header reads, and late handshake/startup
  results are rejected. `localhost` dials only numeric IPv4/IPv6 loopback addresses.
- Startup failure cleans up a successfully launched process. Launch checks the
  selected port before spawning; like any check-then-bind API it cannot reserve
  that port atomically for the child. Use a private, unused port and do not race
  another launcher on it. Browser stdout/stderr are discarded, not pipe-buffered;
  use an externally launched server when logs are required.
- Commands have a finite timeout across all received frames, not a fresh timeout
  per event, ping, fragment or partial read. Python uses a per-command abort
  timer to interrupt blocking transport I/O and rejects responses past the deadline.
  Transport failure or timeout closes the connection (and owned child)
  so a late response cannot contaminate later calls. Protocol/JavaScript errors
  do not close an otherwise healthy connection. Cleanup can add bounded time
  beyond a command's deadline.
- Go accepts a context for cancellation and uses the earlier of its deadline and
  the configured timeout. Mutex acquisition itself is not context-aware. Calls
  are serialized; do not race page close with page operations. Python serializes
  the connection with a reentrant lock and does not expose asynchronous cancellation.
- `navigate`/`Navigate` returns the `Page.navigate` response, **not network idle**.
  For asynchronous pages, explicitly poll a readiness condition under an overall
  application deadline. The clients discard events; no event subscription API,
  downloads, remote handles, automatic retries or full Puppeteer parity is claimed.
- For input/click behavior use supported CDP commands or explicit page expressions;
  no selector automation or undocumented DOM emulation is hidden in these clients.

## Tests

Unit protocol/lifecycle tests run without browser artifacts:

```sh
python3 -m unittest discover -s bindings/python/tests -v
(cd bindings/go && go test -race ./...)
```

Run actual browser smoke checks against an already built executable (no build or
performance benchmark is triggered by these tests):

```sh
export KITESURF_BINARY=/absolute/path/to/kitesurf-fixture
python3 -m unittest discover -s bindings/python/tests -v
(cd bindings/go && go test -race -count=1 -v ./...)
```

Each smoke launches on a dynamically selected unused loopback port and checks
connection ownership, target creation/closure, navigation, by-value evaluation,
JavaScript/protocol errors, PNG bytes and fresh-navigation global isolation.
No installed Node dependency tree is shared with these bindings: Python uses
`websocket-client`, and Go pins `github.com/gorilla/websocket` in its own module.
