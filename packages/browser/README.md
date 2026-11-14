# @vincentkoc/kitesurf-browser-local

A Linux x64 workerd executable embedding the experimental Kitesurf WASM browser. No Node or Wrangler is needed at runtime. This is not Rust compiled to native machine code.

After extracting the package tarball:

```sh
./package/bin/kitesurf --experimental --socket-addr=http=127.0.0.1:18787
```

Connect CDP to `ws://127.0.0.1:18787/devtools/browser`; `/json/version` exposes discovery metadata. Change the port as needed; keep the service bound to loopback. No authentication layer is provided. The production artifact prohibits private-network outbound access and does not contain the opt-in benchmark fixture binary.

Every navigation gets a fresh upstream page isolate. The upstream implementation is incomplete; disposal can emit workerd termination diagnostics despite passing behavior assertions. This is a development tool, not a production-ready service. See [source, tests and build instructions](https://github.com/vincentkoc/kitesurf-wasm). Provenance and upstream/third-party licenses are included.
