# conformance

A probe worker that reports what the **real** VIP host does.

The devkit's host is written from the SDK's sources and README, so it encodes a reading
of the contract rather than the contract itself. Deploy this worker, curl the probe
routes, and compare against the same probes run locally.

```bash
node scripts/build.mjs conformance     # -> build/conformance/release.wasm
node examples/conformance/check.mjs    # the devkit's answers
```

Then deploy `build/conformance/release.wasm` and:

```bash
curl -sSD - https://<site>/__probe/snapshot -o /dev/null | grep x-probe
curl -sS     https://<site>/__probe/fetch-client-phase
curl -sSD - https://<site>/__probe/fetch-origin-phase -o /dev/null | grep x-probe
curl -sS     https://<site>/__probe/kv
curl -sS     https://<site>/__probe/memory-1m
```

The same live probes can be run together with:

```bash
CONFORMANCE_URL=https://<site> npm run test:conformance:live
```

A difference means either a devkit bug or an undocumented host behaviour.

## What it probes

| Route                                               | Question                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/__probe/snapshot`                                 | Does `resp.request` in `onOriginResponse` include request-phase mutations, and does `onClientResponse` correctly _not_? |
| `/__probe/fetch-client-phase`                       | Does `fetch()` work in the allowed phase?                                                                               |
| `/__probe/fetch-origin-phase`                       | Is it refused elsewhere, with `phase_not_allowed`?                                                                      |
| `/__probe/rules-in-request-phase`                   | Are `HtmlRules` registered in a request phase really dropped?                                                           |
| `/__probe/selector`                                 | Which selectors does the host's lol-html accept? One per request via `PROBE_SELECTOR`.                                  |
| `/__probe/kv`                                       | Do KV bytes and counters round-trip?                                                                                    |
| `/__probe/body-marker`                              | Is `req.body` null without the body marker exported?                                                                    |
| `/__probe/memory-256k` through `/__probe/memory-8m` | Can the worker allocate and touch each size?                                                                            |

The snapshot probe matters most: the decide-then-rewrite pattern, and
`mos-proxy`'s plan header, both depend on `onOriginResponse` seeing a header set in
`onClientRequest`.

Probes live on separate routes because AssemblyScript has no `try`/`catch`: an
unsupported selector throws from `install()`, which aborts the instance. Isolating each
probe means an abort only affects that one request.

The memory routes are deliberately separate for the same reason. A `200` response with
`status=allocated` means that size succeeded on the current host; an aborted request or
host error brackets the limit between that size and the previous successful route. The
local checker reports these as observations, not as VIP-compatible limits, because its
host reserves a separate 2 MiB transfer arena.

## Devkit defects it caught

- `fetch()` was **not** phase-gated, so a worker calling it from a response phase passed
  locally and would have failed in production. It now returns `phase_not_allowed`.
- The probe/replay pass applied stateful host calls **twice**, so `KV.incr` returned 2
  instead of 1. The stores are now snapshotted and rolled back between passes.
