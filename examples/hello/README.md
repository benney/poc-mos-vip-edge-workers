# hello

The smallest worker that still exercises the interesting parts of the phase model.

```bash
npm run test:hello   # 9 assertions
npm run hello        # playground at http://localhost:8787
```

`assembly/index.ts` is ~30 lines and does three things:

- **Short-circuits** `/edge-ping` with `respondText`, so origin is never contacted.
- **Passes data between phases** by setting `x-hello-worker` on the request and reading
  it back in `onOriginResponse` via `resp.request`. That is the only channel available;
  module-level variables do not survive between phases.
- **Rewrites the page** with two declarative `HtmlRules`, gated on `content-type` being
  HTML.

It compiles to 19 KB and imports only 8 host functions. The proxy in `assembly/`, which adds
`fetch()`, JSON and config, is 97 KB and imports 18 — most of the difference is json-as.

`check.mjs` is a good starting point for testing your own worker: build, drive both
phases, apply the rules, assert on final bytes.
