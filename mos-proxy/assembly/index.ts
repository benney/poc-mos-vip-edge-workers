// POC: stripped-back MOS proxy for WP-VIP edge workers.
//
// Decides in onClientResponse, after the cache, so VIP caches the origin's page as-is
// and each reader's copy is personalised on the way out. HtmlRules apply there, so the
// page still streams. Endpoint and authenticated routes short-circuit in onClientRequest.
import { onClientRequest, onClientResponse, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { compileHttpBehavior } from "./behavior";
import { loadConfig } from "./config";
import { selectDecisionCookies } from "./cookies";
import { fetchDecisions, ProxyOrigin } from "./decisions";
import { buildResource, resourceFor } from "./resource";
import { handleAuthenticatedRoute, handleCustomEndpoint, identityFromRequest } from "./endpoints";
import { firstIp, wantsDecision } from "./http";
import { applyHttpOps, applyPlan, compilePlan } from "./rules";

export {
  alloc,
  on_client_request,
  on_client_response,
  // Custom endpoints forward the client body; authenticated routes read it as JSON.
  client_request_body,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  const cfg = loadConfig();
  if (!cfg.valid) return; // unconfigured: pass through untouched

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
});

onClientResponse((resp: Response): void => {
  const cfg = loadConfig();
  if (!cfg.valid) return;

  // The client's request as it arrived, before onClientRequest.
  const req = resp.request;
  if (!wantsDecision(cfg, req, resp)) return;

  const path = req.path;
  const host = req.headers.get("host");
  const ua = req.headers.get("user-agent");
  const xff = req.headers.get("x-forwarded-for");
  const referer = req.headers.get("referer");
  const origin = new ProxyOrigin();
  origin.status = resp.status;

  const decisions = fetchDecisions(
    cfg,
    identityFromRequest(cfg, req),
    resourceFor(path, buildResource(req, resp)),
    "https://" + (host === null ? "" : host) + req.url,
    ua === null ? "" : ua,
    xff === null ? "" : firstIp(xff),
    referer === null ? "" : referer,
    selectDecisionCookies(cfg.decisionCookiePatterns, req.cookies, resp.headers.getSetCookie()),
    origin,
  );
  if (decisions === null) return; // fail open: the page as cached

  // Identity is persisted before the behaviour ops, matching the upstream stage order,
  // so a `cookies` replacement in surfaceBehavior overrides it.
  const identifier = decisions.identity.identifier;
  if (identifier.length > 0) resp.headers.append("set-cookie", cfg.anonCookie + "=" + identifier + "; Path=/");

  const behavior = compileHttpBehavior(decisions.surfaceBehavior.http);
  if (behavior !== null) {
    const status = applyHttpOps(behavior.ops, resp.headers);
    if (status != 0) resp.status = <u16>status;
  }

  // The reader's copy is personal. The cached page underneath it is untouched.
  resp.headers.set("cache-control", "private, no-store");

  // A workflow's own body (returnImmediately) replaces the page and skips components.
  if (behavior !== null && behavior.hasBody) {
    resp.setBodyText(behavior.body);
    return;
  }

  applyPlan(compilePlan(cfg, decisions));
});
