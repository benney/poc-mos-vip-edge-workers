# mos-proxy

A [MonetizationOS](https://monetizationos.com) proxy running as a VIP edge worker. MOS
rewrites the page, not the edge: the worker sends the served page to MOS and swaps in
what comes back. It is a hand port of the core `@monetizationos/proxy`, tracking 1.8.0.
The intentional differences are in [`DIVERGENCES.md`](DIVERGENCES.md).

```bash
npm test           # unit assertions
npm run test:e2e   # end-to-end assertions against a fake MOS and origin
npm run test:web   # assertions against the browser bundle
npm run test:live  # assertions against a stand-in org
npm run web        # playground at http://localhost:8787

# Serve the worker over HTTP with real fetches and an in-memory cache, in front of a demo article origin
node scripts/build.mjs mos-proxy
MOS_HOST=http://localhost:4621 MOS_SURFACE_SLUG=articles MOS_SECRET_KEY=sk_... node scripts/serve.mjs mos-proxy
# site on :4700 (EDGE_PORT), demo origin on :4701 (ORIGIN_PORT); ORIGIN_URL replaces the demo
# origin; CACHE_TTL_MS (default 60000) sets how long a page stays cached
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

## Live mode

Copy `.env.local.example` at the repo root to `.env.local` and tick **Live MOS** in the
playground to run against a real org.

```
MOS_HOST=https://api.monetizationos.com
MOS_SURFACE_SLUG=your-surface-slug
MOS_TOKEN=pk_test_yourpublishabletoken
```

Use a **publishable** token. The env panel's `MOS_SECRET_KEY` is just the Bearer token
the worker sends, and the playground is a browser. The UI warns if an `sk_` value is
pasted.

The worker builds its own request, including the Authorization header, exactly as in
production. By default it travels via `POST /live/fetch` on the local server, which
exists only to get past CORS: the API sends no `Access-Control-Allow-Origin`. That
pass-through injects no credentials and alters no headers, binds loopback only, and
refuses any target outside the configured host. `npm run test:live` asserts all of that
against `fake-org.mjs`.

### Publishable tokens cannot send the `http` block

With a `pk_` token the API rejects the request:

```
HTTP 400 {"status":"error","message":"HTTP request information can only be
          included when using a secret API key","statusCode":400}
```

The whole `http` object (`url`, `userAgent`, `clientIP`, `referer`, and the page in
`proxyOrigin`) is secret-key-only, which is sound: a public client should not be able to
assert a client IP. `includeHttp` mirrors that rule, sending `http` only when the key
starts with `sk_`, and `@omitnull()` drops the field otherwise.

**So in live mode, MOS is sent no page, and decisions are made from identity and resource
alone.** Live mode shows identity and header/status ops only. Anything that depends on
the page, client IP, user agent, referer or URL behaves differently here than in
production, where the proxy runs server-side with a secret key.

By default all API paths are proxied, so custom endpoints and authenticated routes reach
the real org and can create records. Point live mode at a test org, or set
`MOS_DECISIONS_ONLY=true`.

## Verified on a VIP deploy (2026-10-18)

On a WordPress subsite behind `starts_with "/mos/"`, with the runtime's body markers exported:

- **`fetch()` in `onClientResponse` works**, carrying a ~93 KB page to MOS and back in
  0.5–0.95 s end to end.
- **VIP keeps caching the origin page.** Repeat requests are `x-cache: HIT` with a fresh
  decision each time.
- **No compression after `onClientResponse`.** A client sending `accept-encoding: gzip, br`
  gets the transformed page uncompressed.

## Unverified against the real host

- **The runtime's body markers buffer every response**, not just pages: images, feeds and
  downloads too, up to the host's buffered-body limit. Per the runtime source, a response
  whose `content-length` is over the limit skips a `continue` worker and is served as is,
  and one without a `content-length` that turns out to be over it is a 502. Not yet observed.
- **Memory.** The stub runtime never frees within a phase. The page, its JSON-encoded copy,
  the MOS response and the served page all coexist, roughly 4x the page size. A 1.8 MB page
  round-trips in about 34 ms in the local host.

`examples/conformance` is the place to probe these.
