// Compiles surfaceBehavior.http into ops. Header/status changes apply in the response
// phase; a `body` key means returnImmediately, which we serve from the request
// phase via respondWith so no origin_response_body buffering is needed.
import { JSON } from "json-as";
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

  isEmpty(): bool {
    return this.st == 0 && !this.hrep && !this.ckreset
      && this.hset.length == 0 && this.hdel.length == 0 && this.ck.length == 0;
  }
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

  // statusText is accepted and ignored: this host does not send it on the wire.

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
