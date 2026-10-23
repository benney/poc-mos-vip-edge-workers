// The resource each surface decision is made for. Edit buildResource per site.
import { Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";

/**
 * Extra resource fields, as the upstream proxy's ResourceProvider: return only the keys to add or
 * override. Workflows read them as `resource.<name>`. Leave `meta` to MOS, which fills it from the page (D2).
 * Values are strings only (D14).
 *
 * Runs in onClientResponse, so the origin's response headers are available too, e.g.
 * `resp.headers.get("x-wp-post-id")`.
 */
export function buildResource(req: Request, resp: Response): Map<string, string> {
  return new Map<string, string>();
}

/** `{ id: path }` with the extra fields merged over it, shallow, as upstream. */
export function resourceFor(path: string, extra: Map<string, string>): Map<string, string> {
  const resource = new Map<string, string>();
  resource.set("id", path);
  const keys = extra.keys();
  for (let i = 0; i < keys.length; i++) resource.set(keys[i], extra.get(keys[i]));
  return resource;
}
