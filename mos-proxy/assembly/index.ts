// POC: stripped-back MOS proxy for WP-VIP edge workers.
//
// fetch() is client-request phase only and HtmlRules only apply in response
// phases, so the pipeline is split: decide in onClientRequest, carry a compact
// rule IR forward in a request header, replay it in onOriginResponse.
import { onClientRequest, onOriginResponse, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { loadConfig } from "./config";
import { applyHttpOps, applyPlan, buildImmediateResponse, compilePlan, parsePlan, planIsEmpty, PLAN_HEADER, serializePlan } from "./rules";
import { fetchDecisions } from "./decisions";
import { handleAuthenticatedRoute, handleCustomEndpoint, identityFromRequest } from "./endpoints";
import { firstIp, pathOf } from "./http";

export {
  alloc,
  on_client_request,
  on_origin_response,
  // Custom endpoints forward the client body; authenticated routes read it as JSON.
  client_request_body,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

const ASSET_SUFFIXES: string[] = [
  ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif",
  ".ico", ".woff", ".woff2", ".ttf", ".map", ".json", ".xml", ".txt", ".mp4", ".pdf",
];

function looksLikeAsset(path: string): bool {
  const lower = path.toLowerCase();
  for (let i = 0; i < ASSET_SUFFIXES.length; i++) {
    if (lower.endsWith(ASSET_SUFFIXES[i])) return true;
  }
  return false;
}

onClientRequest((req: Request): void => {
  const cfg = loadConfig();
  if (!cfg.valid) return; // unconfigured: pass through untouched

  // Never trust an inbound plan header.
  req.headers.delete(PLAN_HEADER);

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

  // Stage 1c onwards: surface decisions for HTML navigations only.
  if (req.method != "GET") return;
  if (looksLikeAsset(path)) return;
  for (let i = 0; i < cfg.ignorePrefixes.length; i++) {
    if (path.startsWith(cfg.ignorePrefixes[i])) return;
  }

  const ua = req.headers.get("user-agent");
  const xff = req.headers.get("x-forwarded-for");
  const referer = req.headers.get("referer");

  const decisions = fetchDecisions(
    cfg,
    identityFromRequest(cfg, req),
    path,
    fullUrl,
    ua === null ? "" : ua,
    xff === null ? "" : firstIp(xff),
    referer === null ? "" : referer,
  );
  if (decisions === null) return; // fail open

  // surfaceBehavior.http with a `body` key is returnImmediately: replace the
  // response outright and never contact origin.
  const immediate = buildImmediateResponse(decisions);
  if (immediate !== null) {
    req.respondWith(immediate);
    return;
  }

  const plan = compilePlan(cfg, decisions);
  if (planIsEmpty(plan)) return;

  // Only channel that survives into onOriginResponse's request snapshot.
  req.headers.set(PLAN_HEADER, serializePlan(plan));
});

onOriginResponse((resp: Response): void => {
  const planJson = resp.request.headers.get(PLAN_HEADER);
  if (planJson === null || planJson.length == 0) return;

  const plan = parsePlan(planJson);

  // Identity is persisted before the behaviour ops, matching the upstream stage order,
  // so a `cookies` replacement in surfaceBehavior overrides it.
  if (plan.a.length > 0) {
    const cfg = loadConfig();
    if (cfg.valid) {
      resp.headers.append("set-cookie", cfg.anonCookie + "=" + plan.a + "; Path=/");
    }
  }

  const ops = plan.h;
  if (ops !== null) {
    const status = applyHttpOps(ops, resp.headers);
    if (status != 0) resp.status = <u16>status;
  }

  // HtmlRules only apply to text/html, and only components need them.
  const contentType = resp.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().startsWith("text/html")) return;

  if (applyPlan(plan) > 0) {
    // Personalised HTML must not enter the shared cache.
    resp.setCacheControl("no-store");
  }
});
