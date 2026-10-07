# mos-proxy-whole-body

The [`mos-proxy`](../mos-proxy) worker in whole-body mode: MOS rewrites the page instead
of the edge.

```bash
npm run test:whole-body   # 39 end-to-end assertions
```

The streaming worker decides before the origin is contacted and replays the decision as
`HtmlRules` on the way back. MOS never sees the page, and the rules have no end-tag hook.
So it cannot send page metadata or do range replacement.

This worker does everything in `onClientRequest`, the only phase that can `fetch()`:

```
onClientRequest   GET html navigation
                    fetch(origin + url)            client cookies, accept-encoding: identity,
                                                   x-mos-origin-fetch: <token>
                    not uncompressed HTML?    -> respondWith as fetched
                    POST /api/v1/surface-decisions
                         http.proxyOrigin = { status, body }
                    respondWith  origin status + headers
                                 + anon cookie + surfaceBehavior.http ops
                                 + surfaceBehavior.http.body if present, else the origin page
                                 cache-control: no-store
```

MOS fills `resource.meta` from the page and applies `componentBehaviors` with the same
transforms as the Cloudflare proxy, `replaceRange` included. That needs firecrest's
`feature/proxy-origin-body`, whole-body mode switched on for the org in sudo (MOS answers
403 otherwise), and a secret (`sk_`) key, because `http` is secret-key only. The field is
undocumented.

## Config

As `mos-proxy`, except `MOS_INJECT_SCRIPT_URL`, which this worker ignores. Plus:

| Var | Default | Notes |
|---|---|---|
| `MOS_ORIGIN_URL` | the request's own host | Where pages are fetched from, e.g. a direct origin hostname |

## The origin fetch

By default the worker fetches its own host. That presumably re-enters the edge, and so
this worker. It recognises its own fetch by `x-mos-origin-fetch` and passes it through.
The value is an HMAC of the secret key, so a client can't send it to get the page
unmodified. A forged value is stripped and the request is handled normally.

## Failure handling

| Failure | Served |
|---|---|
| Origin fetch fails (timeout, transport) | Pass-through: VIP's own origin path serves the page |
| MOS fails | The origin page as fetched, unmodified (fetched once, not twice) |
| Origin page is compressed, non-HTML or a redirect | As fetched, no MOS call |
| Unconfigured | Pass-through |

As with every MOS proxy, a failed decision serves the full page.

## Unverified against the real host

- **2 s per fetch.** The origin must render inside it, then MOS gets its own 2 s.
- **Self-fetch behaviour.** Does a fetch to the site's own host re-enter the worker? Does it
  hit the cache? Does it keep the `Host`? Set `MOS_ORIGIN_URL` if it doesn't work.
- **Memory.** The stub runtime never frees within a phase. The page, its JSON-encoded copy,
  the MOS response and the served page all coexist, roughly 4x the page size. A 1.8 MB page
  round-trips in about 34 ms in the local host.
- **Whether `fetch()` follows redirects.** A 3xx is served as fetched.

`examples/conformance` is the place to probe these.
