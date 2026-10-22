// POC: MOS proxy for WP-VIP edge workers.
//
// Runs in onClientResponse, after the cache: VIP serves the page from its cache or the
// origin as usual, and this worker sends it to MOS and swaps in what comes back. MOS
// applies componentBehaviors server-side and fills resource.meta from the page.
import { onClientRequest, onClientResponse, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { Config, loadConfig } from "./config";
import { selectDecisionCookies } from "./cookies";
import { fetchDecisions, ProxyOrigin } from "./decisions";
import { buildResource, resourceFor } from "./resource";
import { sampleReader } from "./sampling";
import { handleAuthenticatedRoute, handleCustomEndpoint, identityForDecision } from "./endpoints";
import { clientIpFrom, mayBePage, wantsDecision } from "./http";
import { applyHttpOps, compileHttpBehavior, statusAllowsBody } from "./behavior";

export {
  alloc,
  on_client_request,
  on_client_response,
  // Custom endpoints forward the client body; authenticated routes read it as JSON.
  client_request_body,
  // Buffers every client response, not just pages; anything else passes straight through.
  client_response_body,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

// The runtime's body marker names, which the SDK's don't match: needs_ since
// edge-workers 6c106196 (2026-10-14), on_ before it. Without these VIP never buffers
// the page and resp.text() is null. See mos-proxy/README.md.
export function needs_client_request_body(): void {}
export function needs_client_response_body(): void {}
export function on_client_request_body(): void {}
export function on_client_response_body(): void {}

/** MOS can only read an uncompressed page; a compressed one is served as it is (D7). */
function isUncompressed(resp: Response): bool {
  const encoding = resp.headers.get("content-encoding");
  return encoding === null || encoding.length == 0 || encoding.toLowerCase() == "identity";
}

onClientRequest((req: Request): void => {
  const cfg = loadConfig();
  if (!cfg.valid) return; // unconfigured: pass through untouched (D21)

  const path = req.path;
  const host = req.headers.get("host");
  const fullUrl = "https://" + (host === null ? "" : host) + req.url;

  // Stage 1a: custom endpoint routing (any method).
  if (path.startsWith(cfg.mosEndpointsPrefix)) {
    handleCustomEndpoint(cfg, req, path);
    return;
  }

  // Stage 1b: authenticated API routing (POST/PUT/PATCH).
  if (handleAuthenticatedRoute(cfg, req, path, fullUrl)) return;

  // MOS needs the page uncompressed, which has to be asked for before the response exists.
  // Every page request asks for the same variant, so the cache still shares one copy.
  if (mayBePage(cfg, req)) req.headers.set("accept-encoding", "identity");
});

onClientResponse((resp: Response): void => {
  const cfg = loadConfig();
  if (!cfg.valid) return;

  // The client's request as it arrived, before onClientRequest.
  const req = resp.request;
  if (!wantsDecision(cfg, req, resp) || !isUncompressed(resp)) return;
  const sample = sampleReader(cfg, req);
  // Outside MOS_DECISIONS_PERCENT (D4): the page as served.
  if (sample.inSample) decide(cfg, req, resp);
  // Last, so the decision neither forwards it as an origin cookie nor replaces it.
  const bucketCookie = sample.setCookie;
  if (bucketCookie !== null) resp.headers.append("set-cookie", bucketCookie);
});

function decide(cfg: Config, req: Request, resp: Response): void {
  const html = resp.text();
  if (html === null) return;

  const origin = new ProxyOrigin();
  origin.status = resp.status;
  origin.body = html;

  const path = req.path;
  const host = req.headers.get("host");
  const ua = req.headers.get("user-agent");
  const xff = req.headers.get("x-forwarded-for");
  const referer = req.headers.get("referer");
  const decisions = fetchDecisions(
    cfg,
    identityForDecision(cfg, req.cookies, resp.headers.getSetCookie()),
    resourceFor(path, buildResource(req, resp)),
    "https://" + (host === null ? "" : host) + req.url,
    ua,
    clientIpFrom(xff),
    referer,
    selectDecisionCookies(cfg.decisionCookiePatterns, req.cookies, resp.headers.getSetCookie()),
    origin,
  );
  if (decisions === null) return; // fail open: the page as served (D12)

  // Identity is persisted before the behaviour ops, matching the upstream stage order,
  // so a `cookies` replacement in surfaceBehavior overrides it. Re-set whenever MOS returns one (D3).
  const identifier = decisions.identity.identifier;
  if (identifier.length > 0) resp.headers.append("set-cookie", cfg.anonCookie + "=" + identifier + "; Path=/");

  // MOS returns the transformed page, or the workflow's own, in surfaceBehavior.http.body.
  const behavior = compileHttpBehavior(decisions.surfaceBehavior.http);
  if (behavior !== null) {
    const status = applyHttpOps(behavior.ops, resp.headers);
    if (status != 0) resp.status = <u16>status;
    if (behavior.hasBody) resp.setBodyText(behavior.body);
    // Core nulls the body whenever the final status cannot carry one.
    if (!statusAllowsBody(<i32>resp.status)) resp.setBodyText("");
  }

  // The reader's copy is personal (D8). The cached page underneath it is untouched.
  resp.headers.set("cache-control", "private, no-store");
}
