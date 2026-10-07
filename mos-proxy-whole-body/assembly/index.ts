// POC: MOS proxy for WP-VIP edge workers in whole-body mode.
//
// fetch() only works in onClientRequest, so this phase does everything: fetch the
// page from origin, send it to MOS, and respondWith what comes back. MOS applies
// componentBehaviors server-side and fills resource.meta from the page, so range
// replacement and page metadata work here, unlike the streaming mos-proxy worker.
import {
  fetch, Headers, hexEncode, hmacSha256Str, onClientRequest, Request, Response, ResponseInit, secureCompare,
} from "@automattic/vip-edge-workers-sdk/assembly/index";
import { compileHttpBehavior, statusAllowsBody } from "../../mos-proxy/assembly/behavior";
import { Config, loadConfig } from "../../mos-proxy/assembly/config";
import { fetchDecisions, ProxyOrigin } from "../../mos-proxy/assembly/decisions";
import { handleAuthenticatedRoute, handleCustomEndpoint, identityFromRequest } from "../../mos-proxy/assembly/endpoints";
import { firstIp, forwardHeaders, looksLikeAsset, pathOf } from "../../mos-proxy/assembly/http";
import { applyHttpOps } from "../../mos-proxy/assembly/rules";

export {
  alloc,
  on_client_request,
  // Custom endpoints forward the client body; authenticated routes read it as JSON.
  client_request_body,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

/**
 * Marks the worker's own origin fetch. Fetching the site's own host re-enters this
 * worker, which must then pass the request through. The value is derived from the
 * secret key so a client cannot send it to get the unmodified page.
 */
export const ORIGIN_FETCH_HEADER: string = "x-mos-origin-fetch";

// The host sets these on the response it sends; copying the origin's would be stale.
const DROPPED_RESPONSE_HEADERS: string[] = ["content-length", "transfer-encoding", "connection", "keep-alive"];

function originFetchToken(cfg: Config): string {
  return hexEncode(hmacSha256Str(cfg.mosSecretKey, ORIGIN_FETCH_HEADER));
}

function isOwnOriginFetch(req: Request, token: string): bool {
  const value = req.headers.get(ORIGIN_FETCH_HEADER);
  if (value === null || value.length != token.length) return false;
  return secureCompare(Uint8Array.wrap(String.UTF8.encode(value)), Uint8Array.wrap(String.UTF8.encode(token)));
}

function copyResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  const entries = source.entries();
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i][0].toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.includes(name)) continue;
    out.append(name, entries[i][1]);
  }
  return out;
}

function respondUnchanged(req: Request, origin: Response): void {
  const init = new ResponseInit();
  init.status = origin.status;
  init.headers = copyResponseHeaders(origin.headers);
  req.respondWith(new Response(origin.body, init));
}

/** Only an uncompressed HTML page can go to MOS; anything else is served as fetched. */
function isTransformableHtml(origin: Response): bool {
  if (origin.status >= 300 && origin.status < 400) return false;
  const contentType = origin.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().startsWith("text/html")) return false;
  const encoding = origin.headers.get("content-encoding");
  return encoding === null || encoding.length == 0 || encoding.toLowerCase() == "identity";
}

onClientRequest((req: Request): void => {
  const cfg = loadConfig();
  if (!cfg.valid) return; // unconfigured: pass through untouched

  const token = originFetchToken(cfg);
  if (isOwnOriginFetch(req, token)) return;
  req.headers.delete(ORIGIN_FETCH_HEADER);

  const path = pathOf(req.url);
  const hostHeader = req.headers.get("host");
  const host = hostHeader === null ? "" : hostHeader;
  const fullUrl = "https://" + host + req.url;

  // Stage 1a: custom endpoint routing (any method).
  if (path.startsWith(cfg.mosEndpointsPrefix)) {
    handleCustomEndpoint(cfg, req, path);
    return;
  }

  // Stage 1b: authenticated API routing (POST/PUT/PATCH).
  if (handleAuthenticatedRoute(cfg, req, path, fullUrl)) return;

  // Surface decisions for HTML navigations only.
  if (req.method != "GET") return;
  if (looksLikeAsset(path)) return;
  for (let i = 0; i < cfg.ignorePrefixes.length; i++) {
    if (path.startsWith(cfg.ignorePrefixes[i])) return;
  }

  // Client cookies go to origin so logged-in WordPress pages render as that user.
  const originHeaders = forwardHeaders(req, ORIGIN_FETCH_HEADER);
  originHeaders.set("accept-encoding", "identity");
  originHeaders.set(ORIGIN_FETCH_HEADER, token);
  const originBase = cfg.originUrl.length > 0 ? cfg.originUrl : "https://" + host;
  const origin = fetch(originBase + req.url, { method: "GET", headers: originHeaders });

  // Fail open: VIP's own origin path serves the page.
  if (origin.isError()) return;

  if (!isTransformableHtml(origin)) {
    respondUnchanged(req, origin);
    return;
  }
  const html = origin.text();
  if (html === null) {
    respondUnchanged(req, origin);
    return;
  }

  const proxyOrigin = new ProxyOrigin();
  proxyOrigin.status = origin.status;
  proxyOrigin.body = html;
  if (cfg.injectScriptUrl.length > 0) proxyOrigin.injectScriptUrl = cfg.injectScriptUrl;

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
    proxyOrigin,
  );

  // Fail open with the page already in hand rather than fetching it again.
  if (decisions === null) {
    respondUnchanged(req, origin);
    return;
  }

  const headers = copyResponseHeaders(origin.headers);
  let status: i32 = origin.status;
  let body: string = html;

  // Identity is persisted before the behaviour ops, matching the upstream stage order,
  // so a `cookies` replacement in surfaceBehavior overrides it.
  const identifier = decisions.identity.identifier;
  if (identifier.length > 0) headers.append("set-cookie", cfg.anonCookie + "=" + identifier + "; Path=/");

  // MOS returns the transformed page, or the workflow's own, in surfaceBehavior.http.body.
  const behavior = compileHttpBehavior(decisions.surfaceBehavior.http);
  if (behavior !== null) {
    const statusOverride = applyHttpOps(behavior.ops, headers);
    if (statusOverride != 0) status = statusOverride;
    if (behavior.hasBody) body = behavior.body;
  }

  // Personalised HTML must not enter a shared cache.
  headers.set("cache-control", "no-store");

  const init = new ResponseInit();
  init.status = <u16>status;
  init.headers = headers;
  const bytes = statusAllowsBody(status) && body.length > 0 ? Uint8Array.wrap(String.UTF8.encode(body)) : null;
  req.respondWith(new Response(bytes, init));
});
