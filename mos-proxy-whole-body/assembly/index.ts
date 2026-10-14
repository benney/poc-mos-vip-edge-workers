// POC: MOS proxy for WP-VIP edge workers in whole-body mode.
//
// Runs in onClientResponse, after the cache: VIP serves the page from its cache or the
// origin as usual, and this worker sends it to MOS and swaps in what comes back. MOS
// applies componentBehaviors server-side and fills resource.meta from the page, so range
// replacement and page metadata work here, unlike the streaming mos-proxy worker.
import { onClientRequest, onClientResponse, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { compileHttpBehavior } from "../../mos-proxy/assembly/behavior";
import { loadConfig } from "../../mos-proxy/assembly/config";
import { fetchDecisions, ProxyOrigin } from "../../mos-proxy/assembly/decisions";
import { handleAuthenticatedRoute, handleCustomEndpoint, identityFromRequest } from "../../mos-proxy/assembly/endpoints";
import { firstIp, mayBePage, pathOf, wantsDecision } from "../../mos-proxy/assembly/http";
import { applyHttpOps } from "../../mos-proxy/assembly/rules";

export {
  alloc,
  on_client_request,
  on_client_response,
  // Custom endpoints forward the client body; authenticated routes read it as JSON.
  client_request_body,
  // Buffers every client response, not just pages; anything else passes straight through.
  client_response_body,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

/** MOS can only read an uncompressed page; a compressed one is served as it is. */
function isUncompressed(resp: Response): bool {
  const encoding = resp.headers.get("content-encoding");
  return encoding === null || encoding.length == 0 || encoding.toLowerCase() == "identity";
}

onClientRequest((req: Request): void => {
  const cfg = loadConfig();
  if (!cfg.valid) return; // unconfigured: pass through untouched

  const path = pathOf(req.url);
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
  const html = resp.text();
  if (html === null) return;

  const origin = new ProxyOrigin();
  origin.status = resp.status;
  origin.body = html;

  const path = pathOf(req.url);
  const host = req.headers.get("host");
  const ua = req.headers.get("user-agent");
  const xff = req.headers.get("x-forwarded-for");
  const referer = req.headers.get("referer");
  const decisions = fetchDecisions(
    cfg,
    identityFromRequest(cfg, req),
    path,
    "https://" + (host === null ? "" : host) + req.url,
    ua === null ? "" : ua,
    xff === null ? "" : firstIp(xff),
    referer === null ? "" : referer,
    origin,
  );
  if (decisions === null) return; // fail open: the page as served

  // Identity is persisted before the behaviour ops, matching the upstream stage order,
  // so a `cookies` replacement in surfaceBehavior overrides it.
  const identifier = decisions.identity.identifier;
  if (identifier.length > 0) resp.headers.append("set-cookie", cfg.anonCookie + "=" + identifier + "; Path=/");

  // MOS returns the transformed page, or the workflow's own, in surfaceBehavior.http.body.
  const behavior = compileHttpBehavior(decisions.surfaceBehavior.http);
  if (behavior !== null) {
    const status = applyHttpOps(behavior.ops, resp.headers);
    if (status != 0) resp.status = <u16>status;
    if (behavior.hasBody) resp.setBodyText(behavior.body);
  }

  // The reader's copy is personal. The cached page underneath it is untouched.
  resp.headers.set("cache-control", "private, no-store");
});
