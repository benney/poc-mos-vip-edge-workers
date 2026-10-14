# mos-proxy

A CDN proxy for [MonetizationOS](https://monetizationos.com) running as a VIP edge
worker. This is the worker the devkit was built to test: it calls an external API,
parses JSON, resolves identity from cookies, and rewrites HTML from the API's response.

```bash
npm test           # 99 unit assertions
npm run test:e2e   # 92 end-to-end assertions
npm run test:web   # 26 assertions against the browser bundle
npm run test:live  # 22 assertions against a stand-in org
npm run web        # playground at http://localhost:8787

# As a local edge in front of a demo article, against a real MOS (e.g. a local firecrest)
node scripts/build.mjs mos-proxy
MOS_HOST=http://localhost:4621 MOS_SURFACE_SLUG=articles MOS_SECRET_KEY=sk_... npm run serve
```

It is a partial port. The original runs server-side on Cloudflare/Fastly/Akamai with a
streaming HTML rewriter and programmatic element handlers; the subset the SDK's phase
model can express is described below, along with what it cannot.

## The pipeline

The host allows `fetch()` in every phase (SDK `main`, 2026-10-13), and `HtmlRules` apply in
response phases. So page decisions run in `onClientResponse`, after the cache:

```
onClientRequest   1a  /mos-endpoints/*      -> fetch API, respondWith  (short-circuit)
                  1b  authenticated routes  -> merge body + identity, respondWith
                              |
                    (cache, or origin on a miss: the page is stored as the origin sent it)
                              |
onClientResponse      text/html response, not a redirect, path not ignored
                                            -> read identity cookies from resp.request
                                               fetch() POST /api/v1/surface-decisions
                                               Set-Cookie: anonymous id
                                               apply header/status changes
                                               cache-control: private, no-store
                                               response carries a `body`?
                                                 yes -> setBodyText, skip components
                                                 no  -> compile rules -> HtmlRules.install()
```

VIP caches the page the origin sent, and each reader's copy is personalised on the way
out. The origin renders a page once per cache lifetime, not once per reader.
`resp.request` in `onClientResponse` is the request as the client sent it, which is all
the decision needs.

## What works

| Capability | Notes |
|---|---|
| Identity from cookies | JWT wins, then an existing anonymous id, else mint a new one |
| Surface-decisions call | json-as schemas; dynamic-key `componentBehaviors` via `Map<string, T>` |
| Component injection | `before`/`prepend`/`append`/`after`/`remove` map onto declarative rules |
| Element rendering | `html`, `text` (escaped), and `element` → `<source-id version props>` |
| Custom endpoints | `<prefix>/rest?q` proxied to the API, client method/headers/body forwarded |
| Authenticated routes | Client JSON body merged with resolved identity, called with the configured token |
| HTTP-level behaviour | Header replace/add/remove, cookies, status override, full-body replacement |
| Fail-open | Every failure is a checked return; an unconfigured or erroring worker passes through |

`content.remove` becomes `replace(selector, '')` plus outside inserts, since `before` and
`after` land outside the element boundary and survive removal while `prepend` and `append`
do not.

A response carrying a `body` means "return immediately", which also means HTML rewriting
is skipped. The worker swaps the page with `setBodyText` and keeps the origin's status
and headers, as the upstream proxy does. It does not export `client_response_body`: that
marker is phase-wide and would buffer every response, defeating `HtmlRules` streaming.
Whether the host honours a body set without the marker is unverified; the conformance
probe's `/__probe/set-body-client-response` checks it.

## What it cannot do

| Missing | Why |
|---|---|
| Page metadata in the request | `HtmlRules` is write-only, so `<meta>` tags never reach the worker without buffering the body. The whole-body worker does that. |
| Range replacement between markers | No `onEndTag`, no position counting. |
| Rewriting links in the body | Needs a buffered body, losing streaming and the no-size-ceiling property. |

Also worth knowing: the anonymous cookie is re-set on every request, where the original
only sets it on mint; and every HTML page view makes one decisions call, cached or not.

## Config

Read via `getenv`. `MOS_HOST`, `MOS_SURFACE_SLUG` and `MOS_SECRET_KEY` are required —
missing any one makes the worker pass through untouched.

| Var | Default | Notes |
|---|---|---|
| `MOS_ENDPOINTS_PREFIX` | `/mos-endpoints/` | Custom endpoint path prefix |
| `MOS_AUTHENTICATED_ROUTES` | none | `METHOD /match>/apiPath`, comma-separated. POST/PUT/PATCH only |
| `MOS_ANON_COOKIE` | `mos_anon_id` | |
| `MOS_JWT_COOKIE` | `mos_user_jwt` | |
| `MOS_ANON_FALLBACK` | `true` | `false` opts out of minting a fallback anonymous id |
| `MOS_INJECT_SCRIPT_URL` | none | Injected into `<head>` |
| `MOS_IGNORE_PREFIXES` | none | Comma-separated path prefixes |
| `MOS_IGNORE_PATTERNS` | none | Space-separated path regexes, like the upstream proxy's ignore patterns. A malformed one aborts page requests |
| `MOS_ENVIRONMENT` | derived | Overrides the env path segment; only affects custom endpoints |

## Live mode

Copy `.env.local.example` at the repo root to `.env.local` and tick **Live MOS** in the
playground to run against a real org.

```
MOS_HOST=https://api.monetizationos.com
MOS_SURFACE_SLUG=your-surface-slug
MOS_TOKEN=pk_test_yourpublishabletoken
```

Use a **publishable** token. The env panel's `MOS_SECRET_KEY` is just the Bearer token
the worker sends, and the playground is a browser — the UI warns if an `sk_` value is
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

The whole `http` object — `url`, `userAgent`, `clientIP`, `referer` — is secret-key-only,
which is sound: a public client should not be able to assert a client IP. `includeHttp`
mirrors that rule, sending `http` only when the key starts with `sk_`, and `@omitnull()`
drops the field otherwise.

**So in live mode, decisions are made from identity and resource alone.** Anything that
depends on client IP, user agent, referer or URL behaves differently here than in
production, where the proxy runs server-side with a secret key.

By default all API paths are proxied, so custom endpoints and authenticated routes reach
the real org and can create records — point live mode at a test org, or set
`MOS_DECISIONS_ONLY=true`.
