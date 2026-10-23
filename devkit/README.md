# devkit

The host half of the WordPress VIP edge worker ABI, in dependency-free JavaScript.

The [SDK](https://github.com/Automattic/vip-edge-workers-sdk) ships the guest half:
AssemblyScript sources you compile with `asc`. It ships no host, so there is no way to
execute a worker without deploying it. This implements the host side in Node: the msgpack
wire formats, every host function, and the pointer conventions. That makes a compiled
`.wasm` runnable, testable and inspectable in a browser before it reaches the edge.

| File                         | |
| ---------------------------- | --- |
| [`host.mjs`](host.mjs)       | The host ABI. Runs in Node, a browser or a Web Worker. |
| [`rewrite.mjs`](rewrite.mjs) | Applies a worker's `HtmlRules` with real lol-html, the engine the VIP host uses. |
| [`crypto.mjs`](crypto.mjs)   | Synchronous SHA-256, HMAC and HS256 JWT behind the `crypto.*` host calls. |
| [`chrome.mjs`](chrome.mjs)   | Locates a browser for the CDP-driven suites. |
| [`shims/`](shims)            | CommonJS shims so lol-html bundles for the browser. |

All 32 host functions SDK 0.7 declares are implemented: `header.*`, `request.*`,
`response.*`, `env.*`, `html.*`, `kv.*`, `crypto.*` and `regex.*`.

## Running a worker

```js
import { readFileSync } from 'node:fs';
import { EdgeWorkerHost } from './devkit/host.mjs';
import { applyHtmlRules } from './devkit/rewrite.mjs';

const host = await new EdgeWorkerHost(readFileSync('build/hello/release.wasm')).init();

// Phase 1: the request. Returns the mutated request, or the response if the
// worker short-circuited with respondWith/respondText.
const req = await host.clientRequest({ method: 'GET', url: '/', headers: [['host', 'example.com']] });

// Phase 2: the response. `snapshot` is what the origin saw — the worker reads it
// back through resp.request.
const res = await host.originResponse({ status: 200, headers: [['content-type', 'text/html']], snapshot: req });

// The host collects the rules the worker installed; apply them to get final bytes.
const html = await applyHtmlRules('<html><body><p>hi</p></body></html>', res.rules);
```

`env` supplies `getenv`, and `fetchHandler` answers the worker's outbound `fetch()`:

```js
new EdgeWorkerHost(wasm, {
    env: { API_KEY: 'test' },
    fetchHandler: async ({ method, url, headers, body }) => ({
        status: 200, headers: [['content-type', 'application/json']], body: '{"ok":true}',
    }),
});
```

KV and rate limiters are in-memory and honour the documented caps (64 B keys, 10 KiB
values), so an oversize write fails locally too. `crypto.*` is backed by a pure-JS
SHA-256 rather than WebCrypto, which is async-only and cannot implement a synchronous
host call; `getRandomValues` is the synchronous exception. `regex.*` runs on JS `RegExp`,
where the host runs Rust's `regex` crate: they agree on what workers write in practice, and
the conformance probe's `/__probe/regex` is there to diff the rest.

One wrinkle worth knowing if you write your own harness: `fetch()` is synchronous inside
wasm, but a realistic `fetchHandler` is async. `host.mjs` reruns the phase once per fetch:
each pass replays the results resolved so far, and the first unresolved call gets a benign
error, is recorded, resolved, and the pass reruns. So a fetch can depend on an earlier
one's response.

## How the SDK is consumed

The SDK is consumed as an **unmodified npm dependency**. Nothing is vendored, forked or
patched. `asc` resolves the SDK's AssemblyScript sources out of `node_modules` via
`--path`, which is exactly what the build script in the SDK's own README does:

```
<worker>/assembly/index.ts
  imports @automattic/vip-edge-workers-sdk/assembly/index   (guest half of the ABI)
  compiled by asc --path node_modules  ->  build/<name>/release.wasm
                                              |
                                        devkit/host.mjs     (host half, ours)
```

**`devkit/host.mjs` reimplements the SDK's msgpack encoding in JavaScript**, because
their codec is AssemblyScript and cannot be imported into Node. That leaves duplicated
knowledge with no compile-time link, and the SDK ships no protocol version constant to
check against. Two things guard against drift:

- [`test/wire`](../test/wire) compiles the SDK's _own_ codec and asserts ours
  against it in both directions, byte for byte. A format change fails there instead of
  silently desyncing.
- `@automattic/vip-edge-workers-sdk` is pinned to an exact version, not a caret range,
  so an upgrade is deliberate and runs that suite.

`html-rewriter-wasm` is pinned exactly for the same reason: the browser build rewrites
its `require(String.raw…)` calls with a regex, which is a coupling to its source text.

## Verifying against the real host

**The host here is an implementation of the SDK's sources
and README, not the runtime Automattic runs.** Passing tests locally proves your worker
behaves correctly against this reading of the contract. It does not prove the reading is
right.

Three things are verified by construction:

- **Wire formats** come from the SDK's own `msgpack.ts` and `api.ts` — the host decodes
  exactly what the SDK's encoder writes, rather than a guess at the format.
- **The import surface** is checked against every `@external` declaration in the SDK, so
  a worker cannot call a host function the devkit does not implement.
- **The compiled artifact** is produced by the SDK's own toolchain and exports the ABI
  symbols its `assembly/index.ts` defines.

Not verifiable locally:

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

[`tools/conformance`](../tools/conformance) exists to close that gap. It is a worker
whose only job is to report what the host actually does, as response headers and plain
text. Deploy it once, then diff against the same probes run locally:

```bash
node tools/conformance/check.mjs                     # what the devkit believes
curl -sSD - https://<site>/__probe/snapshot -o /dev/null   # what the host does
```

The probe also checks the devkit against itself; see
[`tools/conformance`](../tools/conformance) for the defects that has caught.

Until it has run on real VIP infrastructure, treat local green as "consistent with the
documented contract", not "will work in production".
