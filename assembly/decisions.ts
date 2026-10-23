// Surface-decisions API: json-as schemas + the fetch. componentBehaviors is not modelled (D2):
// MOS applies it server-side, and json-as skips keys the schema does not name.
import { JSON } from "json-as";
import { fetch, Headers, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { Config } from "./config";
import { PORTED_CORE_VERSION } from "./version";

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
  // MOS applies componentBehaviors to this page and returns it in surfaceBehavior.http.body (D1).
  @omitnull()
  body: string | null = null;
}

// userAgent, clientIP and referer are left out when the request has none, as core does.
@json
export class HttpPayload {
  url: string = "";
  @omitnull()
  userAgent: string | null = null;
  @omitnull()
  clientIP: string | null = null;
  @omitnull()
  referer: string | null = null;
}

@json
export class DecisionsHttpPayload {
  url: string = "";
  @omitnull()
  userAgent: string | null = null;
  @omitnull()
  clientIP: string | null = null;
  @omitnull()
  referer: string | null = null;
  // Cookies matching MOS_SURFACE_DECISIONS_COOKIES; left out when none match.
  @omitnull()
  cookies: Map<string, string> | null = null;
  proxyOrigin: ProxyOrigin = new ProxyOrigin();
}

// Only the keys that apply are sent: one of the three shapes core's `Identity` allows.
@json
export class IdentityPayload {
  @omitif((self: IdentityPayload) => !self.createAnonymousIdentifier)
  createAnonymousIdentifier: bool = false;
  @omitnull()
  anonymousIdentifier: string | null = null;
  @omitnull()
  userJwt: string | null = null;
  @omitif((self: IdentityPayload) => !self.createAnonymousIdentifierFallback)
  createAnonymousIdentifierFallback: bool = false;
}

/** The `x-mos-endpoint-request-context` header value: identity plus client metadata (always empty here, D16). */
@json
export class EndpointRequestContext {
  identity: IdentityPayload = new IdentityPayload();
  clientMetadata: Map<string, string> = new Map<string, string>();
}

@json
export class DecisionsRequest {
  surfaceSlug: string = "";
  identity: IdentityPayload = new IdentityPayload();
  // `{ id: path }` plus buildResource's fields. No `meta`: MOS fills it from the page (D2).
  resource: Map<string, string> = new Map<string, string>();
  // Omitted entirely for publishable tokens, see Config.includeHttp (D9).
  @omitnull()
  http: DecisionsHttpPayload | null = null;
}

export const PROXY_VERSION_HEADER: string = "x-mos-proxy-version";
export const PROXY_CLIENT_HEADER: string = "x-mos-proxy-client";
// Fixed descriptors, where core sends a runtime one (D11).
export const PROXY_CLIENT: string = "vip-edge-worker-poc";
export const WHOLE_BODY_PROXY_CLIENT: string = "vip-edge-worker-whole-body-poc";

/** Proxy identification headers sent on every API call. */
export function setProxyHeaders(headers: Headers, client: string = PROXY_CLIENT): void {
  headers.set(PROXY_VERSION_HEADER, PORTED_CORE_VERSION);
  headers.set(PROXY_CLIENT_HEADER, client);
}

/** Authenticated MOS API call: JSON + secret key + proxy identification. Decisions use Bearer, routes PublicBearer. */
export function mosApiHeaders(cfg: Config, client: string = PROXY_CLIENT, scheme: string = "Bearer"): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", scheme + " " + cfg.mosSecretKey);
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
  userAgent: string | null,
  clientIP: string | null,
  referer: string | null,
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

  // No try/catch in AS, so every failure mode is a checked return. Malformed JSON aborts (D12).
  if (resp.isError()) return null;
  if (!resp.ok) return null;
  const text = resp.text();
  if (text === null || text.length == 0) return null;

  const decisions = JSON.parse<SurfaceDecisions>(text);
  if (decisions.status != "success") return null;
  return decisions;
}
