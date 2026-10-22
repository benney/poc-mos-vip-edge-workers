// Compiles surfaceBehavior.http into ops for the response phase. A `body` key means
// returnImmediately: the body replaces the page and components are skipped.
import { JSON } from "json-as";
import { Headers } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { NameValue } from "./decisions";

/** Typed view of surfaceBehavior.http — both the Set and Modify shapes. */
@json
class HttpFields {
  headers: Map<string, string> | null = null;
  cookies: string[] | null = null;
  addHeaders: NameValue[] | null = null;
  removeHeaders: string[] | null = null;
  addCookies: string[] | null = null;
  status: i32 = 0;
  statusText: string | null = null;
  body: string | null = null;
}

@json
export class HttpOps {
  st: i32 = 0;          // status override (0 = none)
  hrep: bool = false;   // replace the whole header set
  hset: NameValue[] = [];
  hdel: string[] = [];
  ckreset: bool = false;
  ck: string[] = [];
}

export class HttpBehavior {
  ops: HttpOps = new HttpOps();
  hasBody: bool = false;   // `body` key present -> returnImmediately
  body: string = "";
}

/** Statuses below 200, plus 204/205/304, carry no body. */
export function statusAllowsBody(status: i32): bool {
  return status >= 200 && status != 204 && status != 205 && status != 304;
}

function pushNameValue(ops: HttpOps, name: string, value: string): void {
  const nv = new NameValue();
  nv.name = name;
  nv.value = value;
  ops.hset.push(nv);
}

/** Mirrors the upstream proxy's `in`-checks, in the same order. */
export function compileHttpBehavior(raw: JSON.Raw | null): HttpBehavior | null {
  if (raw === null) return null;

  const present = JSON.parse<JSON.Obj>(raw.data);
  if (present.size == 0) return null;

  const fields = JSON.parse<HttpFields>(raw.data);
  const out = new HttpBehavior();
  const ops = out.ops;

  // SetHttpResponse: full header replacement.
  const headers = fields.headers;
  if (present.has("headers") && headers !== null) {
    ops.hrep = true;
    const keys = headers.keys();
    for (let i = 0; i < keys.length; i++) {
      pushNameValue(ops, keys[i], headers.get(keys[i]));
    }
  }

  const cookies = fields.cookies;
  if (present.has("cookies") && cookies !== null) {
    ops.ckreset = true;
    for (let i = 0; i < cookies.length; i++) ops.ck.push(cookies[i]);
  }

  // ModifyHttpResponse: set-not-append, matching the upstream comment.
  const addHeaders = fields.addHeaders;
  if (present.has("addHeaders") && addHeaders !== null) {
    for (let i = 0; i < addHeaders.length; i++) {
      pushNameValue(ops, addHeaders[i].name, addHeaders[i].value);
    }
  }

  const removeHeaders = fields.removeHeaders;
  if (present.has("removeHeaders") && removeHeaders !== null) {
    for (let i = 0; i < removeHeaders.length; i++) ops.hdel.push(removeHeaders[i]);
  }

  const addCookies = fields.addCookies;
  if (present.has("addCookies") && addCookies !== null) {
    for (let i = 0; i < addCookies.length; i++) ops.ck.push(addCookies[i]);
  }

  if (present.has("status") && fields.status != 0) ops.st = fields.status; // truthy, as upstream

  // statusText is accepted and ignored: this host does not send it on the wire (D15).

  if (present.has("body")) {
    out.hasBody = true;
    const body = fields.body;
    out.body = body === null ? "" : body;
  }

  if (out.hasBody && ops.st != 0 && !statusAllowsBody(ops.st)) {
    out.body = "";
  }

  return out;
}

/** Applies ops in order: replace-all, cookie reset, set, delete, append. */
export function applyHttpOps(ops: HttpOps, headers: Headers): i32 {
  if (ops.hrep) {
    const existing = headers.keys();
    for (let i = 0; i < existing.length; i++) headers.delete(existing[i]);
  }
  if (ops.ckreset) headers.delete("set-cookie");
  for (let i = 0; i < ops.hset.length; i++) headers.set(ops.hset[i].name, ops.hset[i].value);
  for (let i = 0; i < ops.hdel.length; i++) headers.delete(ops.hdel[i]);
  for (let i = 0; i < ops.ck.length; i++) headers.append("set-cookie", ops.ck[i]);
  return ops.st;
}
