# poc-mos-vip-edge-workers

A local runner, test harness and browser playground for
[WordPress VIP edge workers](https://www.npmjs.com/package/@automattic/vip-edge-workers-sdk),
plus a real-world example worker.

The SDK ships the guest half of the ABI — AssemblyScript sources you compile with `asc`.
It ships no host, so there is no way to execute a worker without deploying it. This repo
implements the host side in Node: the msgpack wire formats, every host function, and the
pointer conventions. That makes a compiled `.wasm` runnable, testable, and inspectable in
a browser before it ever reaches the edge.

Not affiliated with Automattic. There is one worker, [`mos-proxy`](mos-proxy), a port of a
production CDN proxy. Where it differs from the core proxy is in
[`mos-proxy/DIVERGENCES.md`](mos-proxy/DIVERGENCES.md).

```bash
npm install
npm run test:all      # 323 assertions across the examples
npm run web           # playground at http://localhost:8787
npm run serve         # a worker as a local edge in front of a real MOS (see scripts/serve.mjs)
npm run hello         # playground with the minimal example instead
```

## What's here

|                                                |                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`devkit/host.mjs`](devkit/host.mjs)           | The host ABI in ~380 lines of dependency-free JS. Runs in Node, a browser, or a Web Worker.        |
| [`devkit/rewrite.mjs`](devkit/rewrite.mjs)     | Applies a worker's `HtmlRules` with real lol-html, the same engine the VIP host uses.              |
| [`web/`](web)                                  | Browser playground: edit a request, watch the worker run, read the rewritten HTML.                 |
| [`examples/hello`](examples/hello)             | 18 KB worker. Both phases, a short-circuit, two HTML rules, 9 assertions.                          |
| [`examples/crypto`](examples/crypto)           | Host-executed HMAC and HS256 JWT, verified against `node:crypto`, 15 assertions.                   |
| [`mos-proxy`](mos-proxy)                       | The MOS worker. Sends the served page to MOS after the cache and swaps in its rewrite.             |
| [`examples/conformance`](examples/conformance) | Probe worker: deploy it to learn what the real host does.                                          |
| [`examples/wire`](examples/wire)               | Pins the devkit's JS codec to the SDK's own AssemblyScript codec.                                  |

All 32 host functions SDK 0.6 declares are implemented — `header.*`, `request.*`,
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

## Undocumented behaviour

**`fetch()` works in every phase.** Until 2026-10-13 it was client-request only and any
other phase returned `errorKind: "phase_not_allowed"`. The host lifted that; the change is
on the SDK's `main` branch, not yet in an npm release. A call can now depend on the
response, which is what lets the MOS worker decide in `onClientResponse`, after the cache.

**The SDK's body markers don't match the runtime's.** A worker gets a phase's body only if
it exports that phase's marker, but the SDK exports `client_response_body` and friends while
the runtime looks for `needs_client_response_body` (`on_client_response_body` before
edge-workers `6c106196`, 2026-10-14). Neither runtime name has ever matched, so on VIP
`req.body` and `resp.body` stay null and `text()` returns null, as if no marker were exported.
Every worker here that reads a body exports both runtime names as well, and the devkit
buffers a body only for those names, so a worker relying on the SDK's markers alone fails
locally the way it does on VIP. Found on a real deploy of `mos-proxy`, 2026-10-18.

**`onOriginResponse` is the only phase that can read a header you set.**
`resp.request` in `onClientResponse` is the request as the client sent it, so a header set
in `onClientRequest` is invisible there. In `onOriginResponse` the snapshot is taken at the
origin socket and does include it. SDK 0.6 documents this as per-socket snapshots; before
that it was only observable.

**`HtmlRules` is write-only.** It can insert, replace, remove and set attributes, but it
cannot read. There is no way to get the value of a `<meta>` tag into your worker. There
is also no `onEndTag`, so no range replacement.

**AssemblyScript is not TypeScript.** No closures, no `try`/`catch` (a throw aborts), no
`Promise`, no union types, no spread, no `for…of`, no `Record<string, unknown>`. Fail-open
error handling has to be rebuilt as checked returns.

**`JSON.Obj.getAs<T>()` in json-as only works for `JSON.Obj` and `string`.** Arrays and
`Map` abort with a holey-array error; `getAs<i32>` silently returns `0`. To read a mixed
object, parse it twice — as `JSON.Obj` for key presence, as a typed class for values.
`mos-proxy/assembly/behavior.ts` does this, because it needs to distinguish an absent
key from a null one.

**lol-html must be instantiated in a Web Worker.** `html-rewriter-wasm` does a
_synchronous_ `new WebAssembly.Module()` on a 906 KB binary at import time. Browsers cap
main-thread sync compilation at 4 KB; Web Workers have no cap.

**`html-rewriter-wasm` defeats bundlers on purpose**, writing
`require(String.raw\`./asyncify.js\`)` so the specifier cannot be statically resolved.
[`scripts/build-web.mjs`](scripts/build-web.mjs) rewrites those to static requires in an
`onLoad` hook, shims `fs`/`path`/`util`/`assert`, and inlines the wasm as base64.

**Sandboxed iframes don't appear in CDP full-page screenshots.** They render
out-of-process, so `captureBeyondViewport` shows them blank. Scroll into view and capture
the viewport instead.

## The playground

```bash
npm run web
```

Pick a scenario, edit the env vars, request, or origin HTML, and see the outbound calls,
the rules the worker installed, and the final status, headers and rewritten HTML, with a
sandboxed render preview. It runs the real compiled `.wasm` and real lol-html.

It does not reproduce host limits: the 2 s fetch budget, the per-worker concurrency cap
and real cache behaviour only exist on VIP. Treat it as an inspection surface, not a
fidelity guarantee.

`npm run hello` serves the minimal example instead. Any example with a `presets.mjs` can
be served with `node scripts/build.mjs <name> && node scripts/build-web.mjs <name>`.

The playground shell is example-agnostic, but the **live mode** toggle in
[`server.mjs`](server.mjs) is wired to the `mos-proxy`'s config shape
(`MOS_HOST`/`MOS_SURFACE_SLUG`/`MOS_TOKEN`). Adapt it if you point live mode at a
different API.

## How the SDK is consumed

The SDK is consumed as an **unmodified npm dependency**. Nothing is vendored, forked or
patched. `asc` resolves the SDK's AssemblyScript sources out of `node_modules` via
`--path`, which is exactly what the build script in the SDK's own README does:

```
examples/<name>/assembly/index.ts
  imports @automattic/vip-edge-workers-sdk/assembly/index   (guest half of the ABI)
  compiled by asc --path node_modules  ->  build/<name>/release.wasm
                                              |
                                        devkit/host.mjs     (host half, ours)
```

**`devkit/host.mjs` reimplements the SDK's msgpack encoding in JavaScript**, because
their codec is AssemblyScript and cannot be imported into Node. That leaves duplicated
knowledge with no compile-time link, and the SDK ships no protocol version constant to
check against. Two things guard against drift:

- [`examples/wire`](examples/wire) compiles the SDK's _own_ codec and asserts ours
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
  throw from `install()` aborts — whether that becomes a 500 or fails open is unknown.
- Cache behaviour, and whether `onOriginResponse` really only runs on a cache miss.
- Which selectors the host's lol-html build accepts. This repo pins
  `html-rewriter-wasm@0.4.1`; the host's version may differ.

[`examples/conformance`](examples/conformance) exists to close that gap. It is a worker
whose only job is to report what the host actually does, as response headers and plain
text. Deploy it once, then diff against the same probes run locally:

```bash
node examples/conformance/check.mjs                     # what the devkit believes
curl -sSD - https://<site>/__probe/snapshot -o /dev/null   # what the host does
```

The probe also checks the devkit against itself; see
[`examples/conformance`](examples/conformance) for the defects that has caught.

Until it has run on real VIP infrastructure, treat local green as "consistent with the
documented contract", not "will work in production".

## Testing a worker

Every suite runs against the compiled binary rather than a re-implementation:

| Command                    | What it does                                                            |
| -------------------------- | ----------------------------------------------------------------------- |
| `npm run test:wire`        | Devkit codec vs the SDK's own codec, both directions (45)               |
| `npm run test:hello`       | Minimal worker end to end (9)                                           |
| `npm run test:crypto`      | Host crypto through the ABI, digests checked against `node:crypto` (15) |
| `npm test`                 | Unit-tests worker logic over an explicit UTF-8 ABI (97)                 |
| `npm run test:e2e`         | Full pipeline against a fake API and fake origin (84)                   |
| `npm run test:web`         | The bundled browser worker under a simulated Web Worker (28)            |
| `npm run test:live`        | Drives the playground in headless Chrome against a stand-in org (22)    |
| `npm run test:conformance` | Prints the host-behaviour report to diff against a real deploy          |
| `npm run test:artifacts`   | Builds every release worker and reports startup linear memory           |

`npm run artifact:report` inspects existing release artifacts without rebuilding them.
Once VIP supplies numeric limits, set `MAX_WASM_BYTES` and
`MAX_WASM_MEMORY_BYTES` when running `npm run test:artifacts` to turn the report into a
failing gate. The memory figures are the instantiated module's startup linear memory;
they do not replace a real-host probe for peak allocation or buffered-body behaviour.

`test:live` needs Chrome; set `CHROME_PATH` if it isn't found automatically.

One wrinkle worth knowing if you write your own harness: `fetch()` is synchronous inside
wasm, but a realistic `fetchHandler` is async. `host.mjs` reruns the phase once per fetch:
each pass replays the results resolved so far, and the first unresolved call gets a benign
error, is recorded, resolved, and the pass reruns. So a fetch can depend on an earlier
one's response.

## Layout

```
devkit/host.mjs          host ABI (msgpack, host functions, probe/replay)
devkit/rewrite.mjs       HtmlRules -> real lol-html
devkit/chrome.mjs        locates a browser for the CDP drivers
devkit/shims/            CommonJS shims so lol-html bundles for the browser
web/index.html           playground page
web/ui.mjs               playground UI (main thread)
web/worker.mjs           playground pipeline (Web Worker: host + lol-html)
scripts/build.mjs        asc build for one example
scripts/build-web.mjs    esbuild bundle for one example
scripts/serve.mjs        a worker as a local edge: real fetches, in-memory cache, demo origin
server.mjs               static server, plus an optional live pass-through
devkit/crypto.mjs        sync SHA-256/HMAC/JWT backing the crypto host calls
examples/hello/          minimal worker
examples/crypto/         host-executed HMAC and JWT
mos-proxy/               the MOS worker this devkit was built for
examples/conformance/    probe worker for validating the host
examples/wire/           wire-format conformance against the SDK's codec
```

## License

MIT
