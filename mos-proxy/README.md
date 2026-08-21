# mos-proxy

A CDN proxy for [MonetizationOS](https://monetizationos.com) running as a VIP edge
worker. This is the worker the devkit was built to test: it calls an external API,
parses JSON, resolves identity from cookies, and rewrites HTML from the API's response.

```bash
npm test           # 97 unit assertions
npm run test:e2e   # 84 end-to-end assertions
npm run test:web   # 28 assertions against the browser bundle
npm run test:live  # 22 assertions against a stand-in org
npm run web        # playground at http://localhost:8787
```

It is a partial port. The original runs server-side on Cloudflare/Fastly/Akamai with a
streaming HTML rewriter and programmatic element handlers; the subset the SDK's phase
model can express is described below, along with what it cannot.

## The pipeline

`fetch()` is client-request phase only, and `HtmlRules` apply only in response phases.
So the work splits, with a compact rule IR carried forward in a request header:

```
onClientRequest   1a  /mos-endpoints/*      -> fetch API, respondWith  (short-circuit)
                  1b  authenticated routes  -> merge body + identity, respondWith
                  1c  GET html navigation   -> read identity cookies
                                               fetch() POST /api/v1/surface-decisions
                                               response carries a `body`?
                                                 yes -> respondWith  (short-circuit)
                                                 no  -> compile rule IR + http ops
                                               req.headers.set('x-mos-plan', IR)
                              |
                         (origin)
                              |
onOriginResponse         resp.request.headers.get('x-mos-plan')
                         Set-Cookie: anonymous id
                         apply header/status changes
                         replay IR as HtmlRules -> install()
                         setCacheControl('no-store')
```

`onOriginResponse` is the only phase whose request snapshot includes client-phase
mutations, so it is the only place the plan header can be read back.

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
is skipped. That is served from the *request* phase via `respondWith`, so origin is never
contacted. The alternative would be exporting an `origin_response_body` marker, which is
phase-wide and would force the host to buffer every origin response, defeating
`HtmlRules` streaming for all traffic. It is also safer for a hard paywall: origin never
renders the paid content.

Two consequences of that choice: with a `body`, header add/remove applies to an empty
header set rather than origin's, and an un-overridden status is `200` rather than
origin's, which is not known at request time.

## What it cannot do

| Missing | Why |
|---|---|
| Page metadata in the request | `HtmlRules` is write-only — no way to read `<meta>` tags into the worker. The only phase that could read the HTML has no `fetch()`. |
| Range replacement between markers | No `onEndTag`, no position counting. |
| Rewriting links in the body | Needs a buffered body, losing streaming and the no-size-ceiling property. |
| Regex ignore paths | No `RegExp` in AssemblyScript; `MOS_IGNORE_PREFIXES` is prefix matching. |

Also worth knowing: the anonymous cookie is re-set on every request, where the original
only sets it on mint; and personalised HTML is marked `no-store`, so `onOriginResponse`
runs on every request and there is no cache benefit.

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
