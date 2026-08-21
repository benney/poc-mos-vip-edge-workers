// Request-phase short-circuits: custom endpoint proxying and authenticated API
// routes. Both live in onClientRequest, the only phase where fetch() is allowed.
import { JSON } from "json-as";
import { fetch, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { AuthRoute, Config } from "./config";
import { readCookie } from "./cookies";
import { firstIp, forwardHeaders, pathOf, queryOf, stripLeadingSlash } from "./http";
import { buildIdentity, HttpPayload, IdentityPayload, mosApiHeaders, setProxyHeaders } from "./decisions";

/** Envelope for authenticated routes: the client's own JSON body plus our keys. */
export function mergeBody(clientBody: string, identity: IdentityPayload, http: HttpPayload | null): string {
  // JSON.Obj holds the client's arbitrary keys; no `any`/spread in AS.
  let obj: JSON.Obj;
  const trimmed = clientBody.trim();
  if (trimmed.length > 1 && trimmed.charCodeAt(0) == 0x7b) {
    obj = JSON.parse<JSON.Obj>(trimmed);
  } else {
    obj = new JSON.Obj();
  }
  // Set after parsing, so our keys win over client-supplied ones.
  obj.set<IdentityPayload>("identity", identity);
  // Same rule as the decisions call: publishable tokens may not send `http`.
  if (http !== null) obj.set<HttpPayload>("http", http);
  return JSON.stringify(obj);
}

export function buildHttpPayload(req: Request, fullUrl: string): HttpPayload {
  const http = new HttpPayload();
  http.url = fullUrl;
  const ua = req.headers.get("user-agent");
  if (ua !== null) http.userAgent = ua;
  const xff = req.headers.get("x-forwarded-for");
  if (xff !== null) http.clientIP = firstIp(xff);
  const referer = req.headers.get("referer");
  if (referer !== null) http.referer = referer;
  return http;
}

export function identityFromRequest(cfg: Config, req: Request): IdentityPayload {
  const cookieHeader = req.headers.get("cookie");
  return buildIdentity(
    readCookie(cookieHeader, cfg.anonCookie),
    readCookie(cookieHeader, cfg.jwtCookie),
    cfg.anonFallback,
  );
}

/**
 * Proxies the custom-endpoint prefix to the API. Rewrites `<prefix>/rest?q` to
 * `<mosHost>/api/v1/envs/<env>/endpoints/rest?q`, forwarding the client's
 * method, headers, and body — the client's own auth travels with it.
 */
export function customEndpointTarget(cfg: Config, path: string, query: string): string {
  const rest = stripLeadingSlash(path.slice(cfg.mosEndpointsPrefix.length));
  return cfg.mosHost + "/api/v1/envs/" + cfg.mosEnvironment + "/endpoints/" + rest + query;
}

export function handleCustomEndpoint(cfg: Config, req: Request, path: string): void {
  const target = customEndpointTarget(cfg, path, queryOf(req.url));

  const headers = forwardHeaders(req, "");
  setProxyHeaders(headers);

  const resp: Response = fetch(target, { method: req.method, headers, body: req.body });
  if (resp.isError()) {
    req.respondText(502, "MOS endpoint unavailable");
    return;
  }
  req.respondWith(resp);
}

export function matchRoute(cfg: Config, path: string, method: string): AuthRoute | null {
  const upper = method.toUpperCase();
  for (let i = 0; i < cfg.authRoutes.length; i++) {
    const route = cfg.authRoutes[i];
    if (route.matchPath == path && route.method == upper) return route;
  }
  return null;
}

/**
 * Handles a configured authenticated route. Merges the client's JSON body with the
 * resolved identity (JWT from cookie) and http metadata, then calls MOS with the
 * secret key. Returns false when no route matches.
 */
export function handleAuthenticatedRoute(cfg: Config, req: Request, path: string, fullUrl: string): bool {
  if (cfg.authRoutes.length == 0) return false;
  const route = matchRoute(cfg, path, req.method);
  if (route === null) return false;

  const clientBody = req.text();
  const body = mergeBody(
    clientBody === null ? "" : clientBody,
    identityFromRequest(cfg, req),
    cfg.includeHttp ? buildHttpPayload(req, fullUrl) : null,
  );

  const resp: Response = fetch(cfg.mosHost + route.mosPath, {
    method: route.method,
    headers: mosApiHeaders(cfg),
    body: Uint8Array.wrap(String.UTF8.encode(body)),
  });

  if (resp.isError()) {
    req.respondText(502, "MOS API unavailable");
    return true;
  }
  req.respondWith(resp);
  return true;
}
