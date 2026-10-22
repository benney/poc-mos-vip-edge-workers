Tracks `@monetizationos/proxy` 1.7.0.

The port's scope of conformance is the contract with MOS and proxy conventions: the decisions request shape and headers, identity and the anonymous cookie, ignore patterns, surface-decision cookies, path gating, behaviour ops, custom and authenticated endpoints, and resource building. It is not HTML rewriting. Each difference from core that is intentional, or known and accepted, is listed here. Comments and tests that describe a divergence carry its ID.

Bump `PORTED_CORE_VERSION` in `assembly/version.ts`, `config.portedCoreVersion` in `package.json` and the first line of this file together. `npm test` checks that all three agree.

| ID | Area | Core 1.7.0 | This port | Why |
| --- | --- | --- | --- | --- |
| D1 | Whole-body mode | Sends `http.proxyOrigin.status` only, never the page. Honours `surfaceBehavior.http.body` as a workflow-supplied replacement that skips components. | Also sends `http.proxyOrigin.body` (the page) and swaps in `surfaceBehavior.http.body`, which in this mode is the page MOS transformed. | VIP's edge cannot rewrite HTML, so MOS does it. The `proxyOrigin.body` field is undocumented, needs whole-body enabled for the org (MOS answers 403 otherwise) and an `sk_` key. |
| D2 | HTML rewriting | Applies `componentBehaviors`, injects `injectScriptUrl`, parses page metadata into `resource.meta`, rewrites links. | None of these. `componentBehaviors` is not modelled, and `resource.meta` is omitted. | MOS applies components server-side in whole-body mode and fills `resource.meta` from the page it is sent. |
| D4 | Rollout sampling | None. | `MOS_DECISIONS_PERCENT` and a sticky `mos_bucket` cookie decide which readers get a decision. | Port-only, for a gradual rollout on a live site. |
| D5 | Path gating | Only `surfaceDecisionsIgnorePaths` patterns. | WordPress admin, login, REST, XML-RPC, cron, core, content and feed paths are always skipped. `MOS_IGNORE_PREFIXES` adds plain prefixes. | None of these are reader pages, and skipping them also keeps their compression untouched. |
| D6 | Pattern lists | `surfaceDecisionsIgnorePaths` and `surfaceDecisionsCookies` are comma-separated. A malformed regex is logged and skipped. | `MOS_IGNORE_PATTERNS` and `MOS_SURFACE_DECISIONS_COOKIES` are space-separated. A malformed regex aborts the request. | Space-separated is the port's convention. AssemblyScript cannot catch the regex error. |
| D7 | Compression | Reads the response through the runtime, which decompresses it. | A compressed response is skipped. `accept-encoding: identity` is forced on requests that look like pages, using `mayBePage` (an asset-suffix guess). | MOS needs the page text, and the worker only sees bytes. The guess has to be made before the response exists. |
| D8 | Caching | Leaves cache headers alone. | Sets `cache-control: private, no-store` on decided responses. | The reader's copy is personal, and must not enter a shared cache. The cached page underneath is untouched. |
| D9 | Publishable keys | Always sends the `http` block. | Omits `http` for keys that do not start with `sk_`, on decisions and authenticated routes. | The API rejects `http` unless the key is secret. |
| D10 | Client IP | Asks a runtime `ClientIPProvider`. | Uses the first `x-forwarded-for` hop. | No provider API here. Unknown whether VIP rewrites `x-forwarded-for`, so the value may be client-spoofable. |
| D11 | Client descriptor | `x-mos-proxy-client` is a runtime descriptor such as `cloudflare-workers`. | A fixed `vip-edge-worker-poc`, or `vip-edge-worker-whole-body-poc` on a whole-body decision. | There is one runtime, and the value tells MOS which mode called. |
| D12 | MOS responses | Validates the response shape, logs a warning and fails open. | Checks `status == "success"` only. Malformed JSON aborts the instance (no try/catch in AssemblyScript). Transport errors and non-2xx still fail open. | AssemblyScript has no exceptions. What the host does with an aborted instance is checked by the conformance probes `abort-client-request` and `abort-client-response`. |
| D13 | Authenticated routes | Registered through the builder. `request.json()` rejects a client body that is not JSON. | Registered through `MOS_AUTHENTICATED_ROUTES` (`METHOD /path>/mos/path`, POST, PUT or PATCH like core). A client body that is not a JSON object is treated as `{}`. | Config is env strings here. Tolerating a bad body avoids aborting the worker. |
| D14 | Resource extras | `ResourceProvider` returns arbitrary JSON. | `buildResource` returns string values only. | Typed `Map<string, string>` keeps the AssemblyScript simple. |
| D15 | Status text | Applies `statusText` from behaviour. | Ignores it. | The host cannot send a status text. |
| D16 | Adapters | Identity, ClientMetadata and ClientIP providers, `ConfigFactory`, `onHtmlPipelineError`, a logger. | None. `clientMetadata` is always `{}`. Identity comes from the two configured cookies. | The worker is configured by env vars and edited in place. |
| D17 | Environment | Derived from the key, `sk_<env>_<suffix>` to `<env>_<suffix>`. | Same, plus a `MOS_ENVIRONMENT` override. | Port-only, for hosts that hold the key server-side. |
| D18 | Origin | Fetches the origin, adds `originRequestHeaders`, rewrites origin links. | Not ported. | VIP fronts the origin and serves from its own cache. |
| D19 | Endpoint failures | A failing API fetch propagates the fetcher's error to the platform. | Custom endpoints answer 502 `MOS endpoint unavailable`, authenticated routes 502 `MOS API unavailable`. | A 502 is a clean answer for the client, with no worker error. |
| D20 | Request URL | `http.url` is the request URL as the runtime received it. | `https://` plus the Host header plus the path and query. | The worker sees an origin-relative URL, and assumes https. |
| D21 | Missing config | Fails when the config is invalid (`new URL` throws). | If `MOS_HOST`, `MOS_SURFACE_SLUG` or `MOS_SECRET_KEY` is missing, the worker does nothing. | A half-configured site should keep serving pages. |

D3 (anonymous cookie) is closed: the port sets `mos_anon_id` under core's rule. IDs are never reused.

## Golden-fixture oracle (not built)

The rows above are checked by tests written by hand. A stronger check is to run the core and the port on the same input and diff what each sends to MOS. It is designed here and not built.

- `conformance/oracle.mjs`, run by `npm run test:oracle`. Not part of `test:all`, because it needs the published core.
- A project `.npmrc` with `@monetizationos:registry=https://registry.npmjs.org/`, and a devDependency `@monetizationos/proxy@<portedCoreVersion>`.
- Shared fixtures in `conformance/fixtures/*.json`. Each holds the env and config, the client request, the origin response and the scripted MOS responses.
- Each fixture runs through the core (`MOSProxyBuilder` with a fixture origin fetcher, a recording API fetcher and a no-op `HtmlRewriterAdapter`) and through the port (the devkit `EdgeWorkerHost`).
- Compared: each MOS request (method, path, selected headers, JSON body deep-equal), then the final status, headers and Set-Cookie list. Bodies are excluded.
- Differences are allowlisted in `conformance/divergences.json`, keyed by the D-IDs above. Each entry names the JSON paths or headers it excuses.
- The run fails on any difference that is not allowlisted, and on any allowlist entry that no longer matches a difference (stale).
- Run it on every core bump.
