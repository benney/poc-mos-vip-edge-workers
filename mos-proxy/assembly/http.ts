// URL/header helpers. No URL class in AS — req.url is already origin-relative.
import { Headers, RegExp, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { Config } from "./config";

// Set by the host on the outgoing request; forwarding stale copies breaks the body.
const HOP_HEADERS: string[] = ["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade"];

export function firstIp(value: string): string {
  const comma = value.indexOf(",");
  return comma < 0 ? value.trim() : value.slice(0, comma).trim();
}

export function stripLeadingSlash(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) == 0x2f) i++;
  return s.slice(i);
}

/** Copies client headers for an upstream call, dropping hop-by-hop ones. */
export function forwardHeaders(req: Request, skipExtra: string): Headers {
  const out = new Headers();
  const entries = req.headers.entries();
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i][0].toLowerCase();
    if (name == skipExtra) continue;
    let hop = false;
    for (let j = 0; j < HOP_HEADERS.length; j++) {
      if (name == HOP_HEADERS[j]) { hop = true; break; }
    }
    if (hop) continue;
    out.append(name, entries[i][1]);
  }
  return out;
}

const ASSET_SUFFIXES: string[] = [
  ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif",
  ".ico", ".woff", ".woff2", ".ttf", ".map", ".json", ".xml", ".txt", ".mp4", ".pdf",
];

export function looksLikeAsset(path: string): bool {
  const lower = path.toLowerCase();
  for (let i = 0; i < ASSET_SUFFIXES.length; i++) {
    if (lower.endsWith(ASSET_SUFFIXES[i])) return true;
  }
  return false;
}

// WordPress paths that are never reader pages: admin, login, REST, XML-RPC, cron, core and theme files.
const WORDPRESS_PREFIXES: string[] = [
  "/wp-admin/", "/wp-login.php", "/wp-json/", "/xmlrpc.php", "/wp-cron.php", "/wp-includes/", "/wp-content/",
];
const FEED_TYPES: string[] = ["rss", "rss2", "atom", "rdf"];

/** WordPress feeds: `/feed/`, `/comments/feed/`, `/category/news/feed/atom/` and so on. */
export function isWordPressFeed(path: string): bool {
  const trimmed = path.endsWith("/") ? path.slice(0, path.length - 1) : path;
  const segments = trimmed.split("/");
  const n = segments.length;
  if (n >= 2 && segments[n - 1] == "feed") return true;
  return n >= 3 && segments[n - 2] == "feed" && FEED_TYPES.includes(segments[n - 1]);
}

function isIgnoredPath(cfg: Config, path: string): bool {
  for (let i = 0; i < WORDPRESS_PREFIXES.length; i++) {
    if (path.startsWith(WORDPRESS_PREFIXES[i])) return true;
  }
  if (isWordPressFeed(path)) return true;
  for (let i = 0; i < cfg.ignorePrefixes.length; i++) {
    if (path.startsWith(cfg.ignorePrefixes[i])) return true;
  }
  for (let i = 0; i < cfg.ignorePatterns.length; i++) {
    if (new RegExp(cfg.ignorePatterns[i]).test(path)) return true;
  }
  return false;
}

/**
 * Mirrors the upstream proxy: decisions only for an HTML response that is not a
 * redirect, on a path that is not ignored. The Content-Type check is case-sensitive there too.
 */
export function wantsDecision(cfg: Config, req: Request, resp: Response): bool {
  const contentType = resp.headers.get("content-type");
  if (contentType === null || !contentType.startsWith("text/html")) return false;
  if (resp.status >= 300 && resp.status < 400) return false;
  return !isIgnoredPath(cfg, req.path);
}

/** A request-time guess, for the few things that must be decided before the response exists. */
export function mayBePage(cfg: Config, req: Request): bool {
  return !looksLikeAsset(req.path) && !isIgnoredPath(cfg, req.path);
}
