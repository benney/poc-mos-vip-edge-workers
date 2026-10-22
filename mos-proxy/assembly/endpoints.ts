// Request-phase short-circuits: custom endpoint proxying and authenticated API
// routes. Both live in onClientRequest, the only phase where fetch() is allowed.
import { JSON } from "json-as";
import { Cookies, fetch, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { AuthRoute, Config } from "./config";
import { cookieValue, decodeCookieValue, setCookieValue } from "./cookies";
import { clientIpFrom, forwardHeaders, stripLeadingSlash } from "./http";
import { buildIdentity, EndpointRequestContext, HttpPayload, IdentityPayload, mosApiHeaders, PROXY_CLIENT, setProxyHeaders } from "./decisions";

/** Envelope for authenticated routes: the client's own JSON body plus our keys. */
export function mergeBody(clientBody: string, identity: IdentityPayload, http: HttpPayload | null): string {
  // JSON.Obj holds the client's arbitrary keys; no `any`/spread in AS. A body that is not
  // a JSON object counts as `{}` (D13).
  let obj: JSON.Obj;
  const trimmed = clientBody.trim();
  if (trimmed.length > 1 && trimmed.charCodeAt(0) == 0x7b) {
    obj = JSON.parse<JSON.Obj>(trimmed);
  } else {
    obj = new JSON.Obj();
  }
  // Set after parsing, so our keys win over client-supplied ones.
  // Stored pre-serialised: JSON.Obj evaluates a class's @omitif conditions wrongly (json-as 1.6.0).
  obj.set<JSON.Raw>("identity", new JSON.Raw(JSON.stringify(identity)));
  // Same rule as the decisions call: publishable tokens may not send `http`.
  if (http !== null) obj.set<JSON.Raw>("http", new JSON.Raw(JSON.stringify(http)));
  return JSON.stringify(obj);
}

/** `fullUrl` is `https://` plus the Host header and the request URL, where core has the URL as received (D20). */
export function buildHttpPayload(req: Request, fullUrl: string): HttpPayload {
  const http = new HttpPayload();
  http.url = fullUrl;
  http.userAgent = req.headers.get("user-agent");
  http.clientIP = clientIpFrom(req.headers.get("x-forwarded-for"));
  http.referer = req.headers.get("referer");
  return http;
}

/**
 * Identity for a surface decision. As core's `getExistingCookies`: when the origin response sets
 * either cookie, only the origin's values count and the request's are ignored.
 */
export function identityForDecision(cfg: Config, cookies: Cookies, setCookies: string[]): IdentityPayload {
  const originAnon = setCookieValue(setCookies, cfg.anonCookie);
  const originJwt = setCookieValue(setCookies, cfg.jwtCookie);
  if (originAnon !== null || originJwt !== null) {
    return buildIdentity(originAnon === null ? "" : originAnon, originJwt === null ? "" : originJwt, cfg.anonFallback);
  }
  return buildIdentity(
    decodeCookieValue(cookieValue(cookies, cfg.anonCookie)),
    decodeCookieValue(cookieValue(cookies, cfg.jwtCookie)),
    cfg.anonFallback,
  );
}

/** Identity for custom endpoints and authenticated routes, which see request cookies only. */
export function identityFromRequest(cfg: Config, req: Request): IdentityPayload {
  return identityForDecision(cfg, req.cookies, []);
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
  const target = customEndpointTarget(cfg, path, req.query.length > 0 ? "?" + req.query : "");

  const headers = forwardHeaders(req, "");
  setProxyHeaders(headers);
  // Set, not appended, so a client cannot supply its own copy.
  headers.set("x-mos-key", "PublicBearer " + cfg.mosSecretKey);
  const context = new EndpointRequestContext();
  context.identity = identityFromRequest(cfg, req);
  headers.set("x-mos-endpoint-request-context", JSON.stringify(context));

  const resp: Response = fetch(target, { method: req.method, headers, body: req.body });
  // A failed fetch answers 502 here; core lets the error propagate (D19).
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
    headers: mosApiHeaders(cfg, PROXY_CLIENT, "PublicBearer"),
    body: Uint8Array.wrap(String.UTF8.encode(body)),
  });

  if (resp.isError()) {
    req.respondText(502, "MOS API unavailable");
    return true;
  }
  req.respondWith(resp);
  return true;
}
