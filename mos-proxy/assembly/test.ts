// Test-only entrypoint: exposes the pure logic over an explicit UTF-8 ABI so a Node
// harness asserts against the compiled AssemblyScript, not a TS re-implementation.
import { JSON } from "json-as";
import { Cookies } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { cookieValue, decodeCookieValue } from "./cookies";
import { resourceFor } from "./resource";
import { bucketFor } from "./sampling";
import { isWordPressFeed } from "./http";
import { buildIdentity } from "./decisions";
import { PORTED_CORE_VERSION } from "./version";

// --runtime stub never frees or moves, so dataStart pointers stay valid.
const keep: Uint8Array[] = [];
let outPtrV: usize = 0;
let outLenV: i32 = 0;

export function inAlloc(len: i32): usize {
  const a = new Uint8Array(len);
  keep.push(a);
  return a.dataStart;
}

export function outPtr(): usize { return outPtrV; }
export function outLen(): i32 { return outLenV; }

function setOut(s: string): void {
  const b = Uint8Array.wrap(String.UTF8.encode(s));
  keep.push(b);
  outPtrV = b.dataStart;
  outLenV = b.byteLength;
}

export function testPortedCoreVersion(): void {
  setOut(PORTED_CORE_VERSION);
}

export function testReadCookie(hPtr: usize, hLen: i32, nPtr: usize, nLen: i32): void {
  setOut(cookieValue(new Cookies(String.UTF8.decodeUnsafe(hPtr, hLen)), String.UTF8.decodeUnsafe(nPtr, nLen)));
}

export function testBuildIdentity(aPtr: usize, aLen: i32, jPtr: usize, jLen: i32): void {
  const anon = String.UTF8.decodeUnsafe(aPtr, aLen);
  const jwt = String.UTF8.decodeUnsafe(jPtr, jLen);
  setOut(JSON.stringify(buildIdentity(anon, jwt, true)));
}

// --- config / endpoints / authenticated routes ---
import { loadConfig } from "./config";
import { customEndpointTarget, matchRoute, mergeBody, buildIdentityForTest } from "./testsupport";

export function testLoadConfig(): void { setOut(loadConfig().summary()); }

export function testCustomEndpointTarget(pPtr: usize, pLen: i32, qPtr: usize, qLen: i32): void {
  setOut(customEndpointTarget(loadConfig(), String.UTF8.decodeUnsafe(pPtr, pLen), String.UTF8.decodeUnsafe(qPtr, qLen)));
}

export function testMatchRoute(pPtr: usize, pLen: i32, mPtr: usize, mLen: i32): void {
  const route = matchRoute(loadConfig(), String.UTF8.decodeUnsafe(pPtr, pLen), String.UTF8.decodeUnsafe(mPtr, mLen));
  setOut(route === null ? "" : route.method + " " + route.mosPath);
}

/** body, anonCookieValue, jwtCookieValue, url -> merged MOS payload. */
export function testMergeBody(bPtr: usize, bLen: i32, cPtr: usize, cLen: i32, uPtr: usize, uLen: i32): void {
  setOut(buildIdentityForTest(
    String.UTF8.decodeUnsafe(bPtr, bLen),
    String.UTF8.decodeUnsafe(cPtr, cLen),
    String.UTF8.decodeUnsafe(uPtr, uLen),
  ));
}

import { compileBehaviorSummary, identityForDecisionJson, shouldSetAnonCookieFor, statusAllowsBodyFor } from "./testsupport";

export function testCompileBehavior(pPtr: usize, pLen: i32): void {
  setOut(compileBehaviorSummary(String.UTF8.decodeUnsafe(pPtr, pLen)));
}

export function testIdentityForDecision(cPtr: usize, cLen: i32, sPtr: usize, sLen: i32): void {
  setOut(identityForDecisionJson(String.UTF8.decodeUnsafe(cPtr, cLen), String.UTF8.decodeUnsafe(sPtr, sLen)));
}

export function testShouldSetAnonCookie(
  cPtr: usize, cLen: i32, sPtr: usize, sLen: i32, iPtr: usize, iLen: i32, auth: i32,
): i32 {
  return shouldSetAnonCookieFor(
    String.UTF8.decodeUnsafe(cPtr, cLen),
    String.UTF8.decodeUnsafe(sPtr, sLen),
    String.UTF8.decodeUnsafe(iPtr, iLen),
    auth != 0,
  ) ? 1 : 0;
}

export function testStatusAllowsBody(status: i32): i32 {
  return statusAllowsBodyFor(status) ? 1 : 0;
}

const lines = (s: string): string[] => (s.length == 0 ? [] : s.split("\n"));

export function testDecodeCookie(vPtr: usize, vLen: i32): void {
  setOut(decodeCookieValue(String.UTF8.decodeUnsafe(vPtr, vLen)));
}

/** path, newline-separated name=value extras -> resource JSON. */
export function testResourceFor(pPtr: usize, pLen: i32, ePtr: usize, eLen: i32): void {
  const extra = new Map<string, string>();
  const entries = lines(String.UTF8.decodeUnsafe(ePtr, eLen));
  for (let i = 0; i < entries.length; i++) {
    const eq = entries[i].indexOf("=");
    extra.set(entries[i].slice(0, eq), entries[i].slice(eq + 1));
  }
  setOut(JSON.stringify(resourceFor(String.UTF8.decodeUnsafe(pPtr, pLen), extra)));
}

export function testBucket(iPtr: usize, iLen: i32): i32 {
  return bucketFor(String.UTF8.decodeUnsafe(iPtr, iLen));
}

export function testIsFeed(pPtr: usize, pLen: i32): i32 {
  return isWordPressFeed(String.UTF8.decodeUnsafe(pPtr, pLen)) ? 1 : 0;
}
