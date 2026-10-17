# mos-proxy-whole-body

The [`mos-proxy`](../mos-proxy) worker in whole-body mode: MOS rewrites the page instead
of the edge.

```bash
npm run test:whole-body   # end-to-end assertions against a fake MOS and origin

# Serve the worker over HTTP with real fetches and an in-memory cache, in front of a demo article origin
node scripts/build.mjs mos-proxy-whole-body
MOS_HOST=http://localhost:4621 MOS_SURFACE_SLUG=articles MOS_SECRET_KEY=sk_... node scripts/serve.mjs mos-proxy-whole-body
# site on :4700 (EDGE_PORT), demo origin on :4701 (ORIGIN_PORT); ORIGIN_URL replaces the demo
# origin; CACHE_TTL_MS (default 60000) sets how long a page stays cached
```

The streaming worker replays MOS's decision as `HtmlRules`. MOS never sees the page, and
the rules have no end-tag hook, so it cannot send page metadata or do range replacement.

This worker sends MOS the page itself, from `onClientResponse`, after the cache:

```
onClientRequest   path not an asset or ignored -> accept-encoding: identity
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

## Config

As `mos-proxy`, except `MOS_INJECT_SCRIPT_URL`, which this worker ignores.

## Failure handling

| Failure | Served |
|---|---|
| MOS fails | The page as served, unmodified |
| Response is not `text/html`, is a redirect, is compressed, or the path is ignored | As served, no MOS call |
| Unconfigured | Pass-through |

As with every MOS proxy, a failed decision serves the full page.

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
