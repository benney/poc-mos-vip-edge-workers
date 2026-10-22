// Surface-decisions API: json-as schemas + the fetch. componentBehaviors is not modelled:
// MOS applies it server-side, and json-as skips keys the schema does not name.
import { JSON } from "json-as";
import { fetch, Headers, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { Config } from "./config";

@json
export class DecisionIdentity {
  identifier: string = "";
  isAuthenticated: bool = false;
}

@json
export class NameValue {
  name: string = "";
  value: string = "";
}

// `http` is kept raw and parsed twice: as JSON.Obj for key *presence*
// (an absent `body` and a null one mean different things) and as a typed class for
// values, because JSON.Obj.getAs cannot read arrays or ints.
@json
export class SurfaceBehavior {
  http: JSON.Raw | null = null;
}

@json
export class SurfaceDecisions {
  status: string = "";
  identity: DecisionIdentity = new DecisionIdentity();
  surfaceBehavior: SurfaceBehavior = new SurfaceBehavior();
}

// --- request payload ---

@json
export class ProxyOrigin {
  // The cached or origin status; the response phase knows it.
  status: i32 = 0;
  // MOS applies componentBehaviors to this page and returns it in surfaceBehavior.http.body.
  @omitnull()
  body: string | null = null;
}

@json
export class HttpPayload {
  url: string = "";
  userAgent: string = "";
  clientIP: string = "";
  referer: string = "";
}

@json
export class DecisionsHttpPayload {
  url: string = "";
  userAgent: string = "";
  clientIP: string = "";
  referer: string = "";
  // Cookies matching MOS_SURFACE_DECISIONS_COOKIES; left out when none match.
  @omitnull()
  cookies: Map<string, string> | null = null;
  proxyOrigin: ProxyOrigin = new ProxyOrigin();
}

@json
export class IdentityPayload {
  createAnonymousIdentifier: bool = false;
  anonymousIdentifier: string | null = null;
  userJwt: string | null = null;
  createAnonymousIdentifierFallback: bool = false;
}

@json
export class DecisionsRequest {
  surfaceSlug: string = "";
  identity: IdentityPayload = new IdentityPayload();
  // `{ id: path }` plus buildResource's fields. No `meta`: MOS fills it from the page.
  resource: Map<string, string> = new Map<string, string>();
  // Omitted entirely for publishable tokens — see Config.includeHttp.
  @omitnull()
  http: DecisionsHttpPayload | null = null;
}

export const PROXY_VERSION_HEADER: string = "x-mos-proxy-version";
// This worker's own version (package.json): it is a port, not a release of the upstream proxy.
export const PROXY_VERSION: string = "0.1.0";
export const PROXY_CLIENT_HEADER: string = "x-mos-proxy-client";
export const PROXY_CLIENT: string = "vip-edge-worker-poc";
export const WHOLE_BODY_PROXY_CLIENT: string = "vip-edge-worker-whole-body-poc";

/** Proxy identification headers sent on every API call. */
export function setProxyHeaders(headers: Headers, client: string = PROXY_CLIENT): void {
  headers.set(PROXY_VERSION_HEADER, PROXY_VERSION);
  headers.set(PROXY_CLIENT_HEADER, client);
}

/** Authenticated MOS API call: JSON + secret key + proxy identification. */
export function mosApiHeaders(cfg: Config, client: string = PROXY_CLIENT): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", "Bearer " + cfg.mosSecretKey);
  setProxyHeaders(headers, client);
  return headers;
}

/** Identity precedence: JWT wins, then existing anon id, else mint. */
export function buildIdentity(anonId: string, userJwt: string, fallback: bool): IdentityPayload {
  const id = new IdentityPayload();
  if (userJwt.length > 0) {
    id.userJwt = userJwt;
    id.createAnonymousIdentifierFallback = fallback;
    return id;
  }
  if (anonId.length > 0) {
    id.anonymousIdentifier = anonId;
    return id;
  }
  id.createAnonymousIdentifier = true;
  return id;
}

/** Returns parsed decisions, or null on any failure (fail open). */
export function fetchDecisions(
  cfg: Config,
  identity: IdentityPayload,
  resource: Map<string, string>,
  fullUrl: string,
  userAgent: string,
  clientIP: string,
  referer: string,
  cookies: Map<string, string> | null,
  origin: ProxyOrigin | null = null,
): SurfaceDecisions | null {
  const body = new DecisionsRequest();
  body.surfaceSlug = cfg.surfaceSlug;
  body.identity = identity;
  body.resource = resource;
  if (cfg.includeHttp) {
    const http = new DecisionsHttpPayload();
    http.url = fullUrl;
    http.userAgent = userAgent;
    http.clientIP = clientIP;
    http.referer = referer;
    http.cookies = cookies;
    if (origin !== null) http.proxyOrigin = origin;
    body.http = http;
  }

  const headers = mosApiHeaders(cfg, origin !== null && origin.body !== null ? WHOLE_BODY_PROXY_CLIENT : PROXY_CLIENT);

  const payload = Uint8Array.wrap(String.UTF8.encode(JSON.stringify(body)));
  const resp: Response = fetch(cfg.mosHost + "/api/v1/surface-decisions", {
    method: "POST",
    headers,
    body: payload,
  });

  // No try/catch in AS — every failure mode is a checked return instead.
  if (resp.isError()) return null;
  if (!resp.ok) return null;
  const text = resp.text();
  if (text === null || text.length == 0) return null;

  const decisions = JSON.parse<SurfaceDecisions>(text);
  if (decisions.status != "success") return null;
  return decisions;
}
