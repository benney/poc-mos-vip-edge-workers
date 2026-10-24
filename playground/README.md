# playground

```bash
npm run web
```

Pick a scenario, edit the env vars, request, or origin HTML, and see the outbound calls,
the rules the worker installed, and the final status, headers and rewritten HTML, with a
sandboxed render preview. It runs the real compiled `.wasm` and real lol-html.

It does not reproduce host limits: the 2 s fetch budget, the per-worker concurrency cap
and real cache behaviour only exist on VIP. Treat it as an inspection surface, not a
fidelity guarantee.

`npm run hello` serves the minimal example instead. Any worker with a `presets.mjs` can be
served with `node scripts/build.mjs <name> && node scripts/build-web.mjs <name>`. The
proxy's own scenarios are [`presets.mjs`](presets.mjs) here.

The playground shell is worker-agnostic, but the live mode toggle in
[`server.mjs`](server.mjs) is wired to the proxy's config shape
(`MOS_HOST`/`MOS_SURFACE_SLUG`/`MOS_TOKEN`). Adapt it to point live mode at a different API.

## Live mode

Copy [`.env.local.example`](../.env.local.example) at the repo root to `.env.local` and tick **Live MOS** in the
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
against [`test/fake-org.mjs`](../test/fake-org.mjs).

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

## Browser build notes

**lol-html must be instantiated in a Web Worker.** `html-rewriter-wasm` does a
_synchronous_ `new WebAssembly.Module()` on a 906 KB binary at import time. Browsers cap
main-thread sync compilation at 4 KB; Web Workers have no cap.

**`html-rewriter-wasm` defeats bundlers on purpose**, writing
`require(String.raw\`./asyncify.js\`)` so the specifier cannot be statically resolved.
[`scripts/build-web.mjs`](../scripts/build-web.mjs) rewrites those to static requires in an
`onLoad` hook, shims `fs`/`path`/`util`/`assert`, and inlines the wasm as base64.

**Sandboxed iframes don't appear in CDP full-page screenshots.** They render
out-of-process, so `captureBeyondViewport` shows them blank. Scroll into view and capture
the viewport instead.
