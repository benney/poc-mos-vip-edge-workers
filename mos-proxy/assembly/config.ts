// Config from host env vars. No ConfigFactory/closures in AS — getenv only.
import { getenv } from "@automattic/vip-edge-workers-sdk/assembly/index";

const DEFAULT_ENDPOINTS_PREFIX = "/mos-endpoints/";

export class AuthRoute {
  method: string = "";
  matchPath: string = "";
  mosPath: string = "";
}

export class Config {
  mosHost: string = "";
  surfaceSlug: string = "";
  mosSecretKey: string = "";
  mosEnvironment: string = "";
  mosEndpointsPrefix: string = DEFAULT_ENDPOINTS_PREFIX;
  anonCookie: string = "mos_anon_id";
  jwtCookie: string = "mos_user_jwt";
  injectScriptUrl: string = "";
  ignorePrefixes: string[] = [];
  authRoutes: AuthRoute[] = [];
  anonFallback: bool = true;
  /**
   * The API rejects the `http` block unless the key is a secret one:
   * "HTTP request information can only be included when using a secret API key".
   * Publishable (pk_) tokens therefore omit it, which mirrors the API's own rule.
   */
  includeHttp: bool = true;
  valid: bool = false;

  /** Test-visible snapshot of the parsed config. */
  summary(): string {
    let routes = "";
    for (let i = 0; i < this.authRoutes.length; i++) {
      if (i > 0) routes += "|";
      routes += this.authRoutes[i].method + " " + this.authRoutes[i].matchPath + ">" + this.authRoutes[i].mosPath;
    }
    return this.valid.toString() + "\n" + this.mosHost + "\n" + this.mosEnvironment + "\n"
      + this.mosEndpointsPrefix + "\n" + this.anonCookie + "\n" + this.jwtCookie + "\n"
      + this.anonFallback.toString() + "\n" + routes + "\n" + this.ignorePrefixes.join("|")
      + "\n" + this.includeHttp.toString();
  }
}

/** Derives the env path segment from the key: `sk_<env>_<suffix>` -> `<env>_<suffix>`. */
function deriveEnvironment(secretKey: string): string {
  const parts = secretKey.split("_");
  const a = parts.length > 1 ? parts[1] : "";
  const b = parts.length > 2 ? parts[2] : "";
  return a + "_" + b;
}

/** `METHOD /match>/mos, METHOD /match2>/mos2` — no regex/JSON needed at startup. */
function parseAuthRoutes(spec: string): AuthRoute[] {
  const routes: AuthRoute[] = [];
  const entries = spec.split(",");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i].trim();
    if (entry.length == 0) continue;

    const space = entry.indexOf(" ");
    const arrow = entry.indexOf(">");
    if (space <= 0 || arrow <= space) continue;

    const method = entry.slice(0, space).trim().toUpperCase();
    if (method != "POST" && method != "PUT" && method != "PATCH") continue;

    const r = new AuthRoute();
    r.method = method;
    r.matchPath = entry.slice(space + 1, arrow).trim();
    r.mosPath = entry.slice(arrow + 1).trim();
    if (r.matchPath.length == 0 || r.mosPath.length == 0) continue;
    routes.push(r);
  }
  return routes;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, s.length - 1) : s;
}

export function loadConfig(): Config {
  const c = new Config();
  const host = getenv("MOS_HOST");
  const slug = getenv("MOS_SURFACE_SLUG");
  const key = getenv("MOS_SECRET_KEY");
  if (host === null || slug === null || key === null) return c;
  if (host.length == 0 || key.length == 0) return c;

  c.mosHost = trimTrailingSlash(host);
  c.surfaceSlug = slug;
  c.mosSecretKey = key;
  c.mosEnvironment = deriveEnvironment(key);
  c.includeHttp = key.startsWith("sk_");

  // Normally derived from the key. An explicit override lets a host supply the env
  // without the key's secret suffix — used by the playground's live mode, where the
  // real key stays server-side and the browser only sees a redacted one.
  const environment = getenv("MOS_ENVIRONMENT");
  if (environment !== null && environment.length > 0) c.mosEnvironment = environment;

  const prefix = getenv("MOS_ENDPOINTS_PREFIX");
  if (prefix !== null && prefix.length > 0) c.mosEndpointsPrefix = prefix;
  const anon = getenv("MOS_ANON_COOKIE");
  if (anon !== null && anon.length > 0) c.anonCookie = anon;
  const jwt = getenv("MOS_JWT_COOKIE");
  if (jwt !== null && jwt.length > 0) c.jwtCookie = jwt;
  const script = getenv("MOS_INJECT_SCRIPT_URL");
  if (script !== null) c.injectScriptUrl = script;
  const fallback = getenv("MOS_ANON_FALLBACK");
  if (fallback !== null && fallback == "false") c.anonFallback = false;

  const routes = getenv("MOS_AUTHENTICATED_ROUTES");
  if (routes !== null && routes.length > 0) c.authRoutes = parseAuthRoutes(routes);

  // Comma-separated path prefixes (not regex — no RegExp in AS).
  const ignore = getenv("MOS_IGNORE_PREFIXES");
  if (ignore !== null && ignore.length > 0) {
    const parts = ignore.split(",");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i].trim();
      if (p.length > 0) c.ignorePrefixes.push(p);
    }
  }

  c.valid = true;
  return c;
}
