// URL/header helpers. No URL class in AS — req.url is already origin-relative.
import { Headers, Request } from "@automattic/vip-edge-workers-sdk/assembly/index";

// Set by the host on the outgoing request; forwarding stale copies breaks the body.
const HOP_HEADERS: string[] = ["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade"];

export function pathOf(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

export function queryOf(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? "" : url.slice(q);
}

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
