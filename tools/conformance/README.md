# conformance

A probe worker that reports what the **real** VIP host does.

The devkit's host is written from the SDK's sources and README, so it encodes a reading
of the contract rather than the contract itself. Deploy this worker, curl the probe
routes, and compare against the same probes run locally.

```bash
node scripts/build.mjs conformance     # -> build/conformance/release.wasm
node tools/conformance/check.mjs       # the devkit's answers
```

Then deploy `build/conformance/release.wasm` and:

```bash
curl -sSD - https://<site>/__probe/snapshot -o /dev/null | grep x-probe
curl -sS     https://<site>/__probe/fetch-client-phase
curl -sSD - https://<site>/__probe/fetch-origin-phase -o /dev/null | grep x-probe
curl -sSD - https://<site>/__probe/fetch-client-response-phase -o /dev/null | grep x-probe
curl -sS     https://<site>/__probe/set-body-client-response
curl -sS     https://<site>/__probe/kv
curl -sS     https://<site>/__probe/memory-1m
curl -sSD - https://<site>/__probe/abort-client-request
curl -sSD - https://<site>/__probe/abort-client-response
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
| `/__probe/fetch-origin-phase`                       | Does it work in `onOriginResponse` too? Refused with `phase_not_allowed` until the host change of 2026-10-13             |
| `/__probe/fetch-client-response-phase`              | Does it work in `onClientResponse`, where the MOS worker calls it?                                                          |
| `/__probe/set-body-client-response`                 | Does `setBodyText` in `onClientResponse` replace the page without the runtime's `needs_client_response_body` marker exported? |
| `/__probe/rules-in-request-phase`                   | Are `HtmlRules` registered in a request phase really dropped?                                                           |
| `/__probe/selector`                                 | Which selectors does the host's lol-html accept? One per request via `PROBE_SELECTOR`.                                  |
| `/__probe/regex`                                    | Does the host's Rust regex give what the devkit's JS stand-in gives: named groups, Unicode, templates, UTF-16 indices?  |
| `/__probe/random`                                   | Does `getRandomValues` fill the buffer?                                                                                 |
| `/__probe/kv`                                       | Do KV bytes and counters round-trip?                                                                                    |
| `/__probe/body-marker`                              | Is `req.body` null without the body marker exported?                                                                    |
| `/__probe/abort-client-request`                     | What does the host serve when the worker aborts in `onClientRequest`: an error status, the unmodified page, or something else? |
| `/__probe/abort-client-response`                    | What does the host serve when the worker aborts in `onClientResponse`: an error status, the unmodified page, or something else? |
| `/__probe/memory-256k` through `/__probe/memory-8m` | Can the worker allocate and touch each size?                                                                            |

The snapshot probe documents which phase sees a request-phase header. The MOS worker no
longer depends on it: it decides in `onClientResponse` from the client's request.

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
  locally and would have failed in production. The host has since lifted the gate (SDK
  `main`, 2026-10-13), so the devkit allows it in every phase again.
- The probe/replay pass applied stateful host calls **twice**, so `KV.incr` returned 2
  instead of 1. The stores are now snapshotted and rolled back between passes.

## What is known about the real host

What the SDK does not say, or has since changed, about the real host. Check here before trusting the devkit on any of it.

**`fetch()` works in every phase.** Until 2026-10-13 it was client-request only and any
other phase returned `errorKind: "phase_not_allowed"`. The host lifted that and SDK 0.7.0
shipped it. A call can now depend on the response, which is what lets the MOS worker decide
in `onClientResponse`, after the cache. The SDK's `errorKind` list changed with it:
`phase_not_allowed` is gone and `bad_request` and `hops_exhausted` are new.

**Body markers were misnamed until SDK 0.7.1.** A worker gets a phase's body only if it
exports that phase's marker, but SDK 0.6.0 exported `client_response_body` and friends while
the runtime looks for `needs_client_response_body` (`on_client_response_body` before
edge-workers `6c106196`, 2026-10-14). Neither runtime name had ever matched, so on VIP
`req.body` and `resp.body` stayed null and `text()` returned null, as if no marker were
exported. Found on a real deploy of `mos-proxy`, 2026-10-18. 0.7.0 switched the SDK's exports to the
old `on_` names and 0.7.1 to the current `needs_` ones, so workers re-export the SDK's
markers directly and the devkit buffers a body only for `needs_`.

**Crypto size limits are the host's.** From 0.7.0 `sha256`, `hmacSha256`, `secureCompare`,
`jwtVerifyHs256` and `getRandomValues` throw a `RangeError` when an input is over a limit
the host owns and the SDK no longer states. The devkit doesn't model those limits, so an
oversize input passes locally.

**`onOriginResponse` is the only phase that can read a header you set.**
`resp.request` in `onClientResponse` is the request as the client sent it, so a header set
in `onClientRequest` is invisible there. In `onOriginResponse` the snapshot is taken at the
origin socket and does include it. SDK 0.6 documents this as per-socket snapshots; before
that it was only observable.

**`HtmlRules` is write-only.** It can insert, replace, remove and set attributes, but it
cannot read. There is no way to get the value of a `<meta>` tag into your worker. There
is also no `onEndTag`, so no range replacement.

### Verified on a VIP deploy (2026-10-18)

On a WordPress subsite behind `starts_with "/mos/"`, with the runtime's body markers exported:

- **`fetch()` in `onClientResponse` works**, carrying a ~93 KB page to MOS and back in
  0.5–0.95 s end to end.
- **VIP keeps caching the origin page.** Repeat requests are `x-cache: HIT` with a fresh
  decision each time.
- **No compression after `onClientResponse`.** A client sending `accept-encoding: gzip, br`
  gets the transformed page uncompressed.

### Unverified against the real host

- **The runtime's body markers buffer every response**, not just pages: images, feeds and
  downloads too, up to the host's buffered-body limit. Per the runtime source, a response
  whose `content-length` is over the limit skips a `continue` worker and is served as is,
  and one without a `content-length` that turns out to be over it is a 502. Not yet observed.
- **Memory.** The stub runtime never frees within a phase. The page, its JSON-encoded copy,
  the MOS response and the served page all coexist, roughly 4x the page size. A 1.8 MB page
  round-trips in about 34 ms in the local host.

The probes above are the place to settle these.

### Not verifiable locally

- Whether host-side _semantics_ match the README — most importantly whether
  `onOriginResponse` really sees request-phase header mutations.
- Enforced limits: the 2 s fetch budget, per-worker FIFO concurrency, 1 KiB header names,
  64 KiB values, 256 rules / 64 KiB per `install()`.
- What the host does with an aborted instance. AssemblyScript has no `try`/`catch`, so a
  throw from `install()` aborts — whether that becomes a 500 or fails open is unknown. The conformance probes
  `/__probe/abort-client-request` and `/__probe/abort-client-response` answer it on a deploy.
- Cache behaviour, and whether `onOriginResponse` really only runs on a cache miss.
- Which selectors the host's lol-html build accepts. This repo pins
  `html-rewriter-wasm@0.4.1`; the host's version may differ.
