# poc-mos-vip-edge-workers

A [MonetizationOS](https://monetizationos.com) proxy that runs as a
[WordPress VIP edge worker](https://github.com/Automattic/vip-edge-workers-sdk). MOS
rewrites the page, not the edge: the worker sends the served page to MOS and swaps in what
comes back. It is a hand port of the core `@monetizationos/proxy`, tracking 1.8.0. The
intentional differences are in [`DIVERGENCES.md`](DIVERGENCES.md).

Not affiliated with Automattic. The worker is AssemblyScript compiled to WebAssembly with
the SDK's own toolchain. The SDK ships no host, so the repo also carries the local one it
is tested on: [`devkit/`](devkit).

```bash
npm install
npm run build        # -> build/mos-proxy/release.wasm, the worker to deploy
npm run test:all     # every suite below except test:live
npm run web          # playground at http://localhost:8787
```

## The pipeline

The worker runs in `onClientResponse`, after the cache, and sends MOS the page itself:

```
onClientRequest   1a  /mos-endpoints/*      -> fetch API, respondWith  (short-circuit)
                  1b  authenticated routes  -> merge body + identity, respondWith
                  path not an asset or ignored -> accept-encoding: identity
                        |
              (cache, or origin on a miss: the page is stored as the origin sent it)
                        |
onClientResponse  text/html, not a redirect, path not ignored, uncompressed?
                                       no  -> served as is
                  POST /api/v1/surface-decisions
                       http.proxyOrigin = { status, body }
                  origin status + headers
                    + anon cookie + surfaceBehavior.http ops
                    + surfaceBehavior.http.body if present, else the page as served
                  cache-control: private, no-store
```

VIP caches the origin's page and each reader's copy is transformed on the way out, so
the origin renders a page once per cache lifetime. Every page view still makes one MOS
call carrying the page.

MOS fills `resource.meta` from the page and applies `componentBehaviors` with the same
transforms as the Cloudflare proxy, `replaceRange` included. That needs whole-body mode
switched on for the org (MOS answers 403 otherwise) and a secret (`sk_`) key, because
`http` is secret-key only. The field is undocumented.

`resp.request` in `onClientResponse` is the request as the client sent it, which is all
the decision needs. Identity prefers the anon or JWT cookie the origin sets in its
response over the request's cookies.

## What it does

| Capability | Notes |
|---|---|
| Identity from cookies | JWT wins, then an existing anonymous id, else mint a new one |
| Surface-decisions call | json-as schemas; dynamic-key `componentBehaviors` via `Map<string, T>` |
| Custom endpoints | `<prefix>/rest?q` proxied to the API, client method/headers/body forwarded with `x-mos-key` and `x-mos-endpoint-request-context` |
| Authenticated routes | Client JSON body merged with resolved identity, called with `Authorization: PublicBearer <key>`. The four default routes are always on |
| HTTP-level behaviour | Header replace/add/remove, cookies, status override, full-body replacement |
| Cookies to decisions | `MOS_SURFACE_DECISIONS_COOKIES`: matching request cookies, then the origin's Set-Cookie values, sent decoded as `http.cookies` |
| Resource fields | `buildResource` in `assembly/resource.ts` adds or overrides fields over `{ id: path }`, like the upstream `ResourceProvider`. Edit it per site; string values only |
| Fail-open | Every failure is a checked return; an unconfigured or erroring worker passes through |

The anonymous cookie is set as the original does: when MOS minted the id, or for a JWT fallback that MOS reports unauthenticated when the reader has no anonymous cookie.

## Config

Read via `getenv`. `MOS_HOST`, `MOS_SURFACE_SLUG` and `MOS_SECRET_KEY` are required.
Missing any one makes the worker pass through untouched.

| Var | Default | Notes |
|---|---|---|
| `MOS_HOST` | none | MOS API origin. Required |
| `MOS_SURFACE_SLUG` | none | Surface to decide for. Required |
| `MOS_SECRET_KEY` | none | Required. Must be a secret `sk_` key for the page flow, since `http` is secret-key only |
| `MOS_ENDPOINTS_PREFIX` | `/mos-endpoints/` | Custom endpoint path prefix. These send `x-mos-key: PublicBearer <key>` and `x-mos-endpoint-request-context` |
| `MOS_AUTHENTICATED_ROUTES` | none | `METHOD /match>/apiPath`, comma-separated. POST/PUT/PATCH only. These send `Authorization: PublicBearer <key>`. `POST /mos-api/offer-redemptions`, `/mos-api/access-checks`, `/mos-api/surface-decisions` and `/mos-api/counter-updates` are always appended after this list |
| `MOS_ANON_COOKIE` | `mos_anon_id` | |
| `MOS_JWT_COOKIE` | `mos_user_jwt` | |
| `MOS_ANON_FALLBACK` | `true` | `false` opts out of minting a fallback anonymous id |
| `MOS_IGNORE_PREFIXES` | none | Comma-separated path prefixes |
| `MOS_IGNORE_PATTERNS` | none | Space-separated path regexes, like the upstream proxy's ignore patterns. A malformed one aborts page requests |
| `MOS_SURFACE_DECISIONS_COOKIES` | none | Space-separated cookie-name regexes, like the upstream proxy's `surfaceDecisionsCookies` |
| `MOS_DECISIONS_PERCENT` | `100` | Share of readers (0-100) whose pages call MOS; the rest get the page as cached. Sticky per reader: a random token in a `mos_bucket` cookie, hashed to a bucket. Readers without cookies, such as most crawlers, roll per request |
| `MOS_ENVIRONMENT` | derived | Overrides the env path segment; only affects custom endpoints |

WordPress paths that are never reader pages are always skipped, on top of the ignore lists:
`/wp-admin/`, `/wp-login.php`, `/wp-json/`, `/xmlrpc.php`, `/wp-cron.php`, `/wp-includes/`,
`/wp-content/`, and feeds (`/feed/`, `/comments/feed/`, `/category/news/feed/atom/` and so on).

The `x-mos-proxy-version` header the worker sends is the core version it tracks (1.8.0).

## Failure handling

| Failure | Served |
|---|---|
| MOS fails | The page as served, unmodified |
| Response is not `text/html`, is a redirect, is compressed, or the path is ignored | As served, no MOS call |
| Unconfigured | Pass-through |

As with every MOS proxy, a failed decision serves the full page.

Everything about running against a real org is in [`playground/`](playground). What the
real VIP host is known to do, and the probe that finds out, is in
[`tools/conformance/`](tools/conformance).

## Testing

Every suite runs against the compiled binary rather than a re-implementation.

| Command                    | What it does                                                         |
| -------------------------- | -------------------------------------------------------------------- |
| `npm test`                 | Unit-tests worker logic over an explicit UTF-8 ABI                   |
| `npm run test:e2e`         | Full pipeline against a fake API and fake origin                     |
| `npm run test:web`         | The bundled browser worker under a simulated Web Worker              |
| `npm run test:wire`        | Devkit codec vs the SDK's own codec, both directions                 |
| `npm run test:hello`       | The minimal example end to end                                       |
| `npm run test:conformance` | Prints the devkit's answers to the host probes, to diff against VIP  |
| `npm run test:artifacts`   | Builds every release worker and reports size and startup memory      |
| `npm run test:live`        | Drives the playground in headless Chrome against a stand-in org      |

`test:live` needs Chrome; set `CHROME_PATH` if it isn't found automatically.

`npm run artifact:report` inspects existing release artifacts without rebuilding them. Once
VIP supplies numeric limits, set `MAX_WASM_BYTES` and `MAX_WASM_MEMORY_BYTES` when running
`npm run test:artifacts` to turn the report into a failing gate. The memory figures are the
instantiated module's startup linear memory; they do not replace a real-host probe for peak
allocation or buffered-body behaviour.

## Layout

```
assembly/        the worker (AssemblyScript)
DIVERGENCES.md   where it differs from core @monetizationos/proxy, by ID
test/            unit, e2e, browser-bundle and live suites; wire/ pins the devkit codec to the SDK's
devkit/          the host half of the ABI in JS: msgpack, host functions, real lol-html
playground/      browser playground and local server, with an optional live pass-through
tools/conformance/  probe worker to deploy to VIP, and the devkit's answers to compare
examples/hello/  the smallest worker that exercises both phases
scripts/         asc build, playground bundle, artifact report, a worker as a local edge
```

[`AGENTS.md`](AGENTS.md) says where to look when a question is about the SDK or the real host.

## License

MIT
