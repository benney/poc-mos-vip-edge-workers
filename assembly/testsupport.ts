// Test-only glue: re-exports pure logic and builds payloads without a host Request.
import { JSON } from "json-as";
import { loadConfig } from "./config";
import { Cookies } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { HttpPayload } from "./decisions";
import { identityForDecision, mergeBody, shouldSetAnonCookie } from "./endpoints";

export { customEndpointTarget, matchRoute, mergeBody } from "./endpoints";

/** Mirrors identityFromRequest + buildHttpPayload without a host Request. */
export function buildIdentityForTest(body: string, cookieHeader: string, url: string): string {
  const cfg = loadConfig();
  const cookies = new Cookies(cookieHeader);
  const identity = identityForDecision(cfg, cookies, []);
  const http = new HttpPayload();
  http.url = url;
  return mergeBody(body, identity, cfg.includeHttp ? http : null);
}

import { JSON } from "json-as";
import { compileHttpBehavior, statusAllowsBody } from "./behavior";
import { NameValue, SurfaceBehavior } from "./decisions";

@json
class BehaviorSummary {
  present: bool = false;
  hasBody: bool = false;
  body: string = "";
  st: i32 = 0;
  hrep: bool = false;
  hset: NameValue[] = [];
  hdel: string[] = [];
  ckreset: bool = false;
  ck: string[] = [];
}

/** `{"http":{...}}` -> flattened summary of the compiled behavior. */
export function compileBehaviorSummary(surfaceBehaviorJson: string): string {
  const sb = JSON.parse<SurfaceBehavior>(surfaceBehaviorJson);
  const behavior = compileHttpBehavior(sb.http);
  const out = new BehaviorSummary();
  if (behavior === null) return JSON.stringify(out);

  out.present = true;
  out.hasBody = behavior.hasBody;
  out.body = behavior.body;
  out.st = behavior.ops.st;
  out.hrep = behavior.ops.hrep;
  out.hset = behavior.ops.hset;
  out.hdel = behavior.ops.hdel;
  out.ckreset = behavior.ops.ckreset;
  out.ck = behavior.ops.ck;
  return JSON.stringify(out);
}

export function statusAllowsBodyFor(status: i32): bool { return statusAllowsBody(status); }

/** Cookie header, newline-separated origin Set-Cookie values -> identity JSON for a decision. */
export function identityForDecisionJson(cookieHeader: string, setCookies: string): string {
  const lines: string[] = setCookies.length == 0 ? [] : setCookies.split("\n");
  return JSON.stringify(identityForDecision(loadConfig(), new Cookies(cookieHeader), lines));
}

/** Cookie header, origin Set-Cookie values, the id MOS returned and its isAuthenticated -> whether the anon cookie is set. */
export function shouldSetAnonCookieFor(cookieHeader: string, setCookies: string, identifier: string, isAuthenticated: bool): bool {
  const cfg = loadConfig();
  const cookies = new Cookies(cookieHeader);
  const lines: string[] = setCookies.length == 0 ? [] : setCookies.split("\n");
  return shouldSetAnonCookie(cfg, cookies, lines, identityForDecision(cfg, cookies, lines), identifier, isAuthenticated);
}
