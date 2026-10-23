// Cookie lookup over the SDK's parser, "" when absent, as the identity payload wants.
import { Cookies, RegExp } from "@automattic/vip-edge-workers-sdk/assembly/index";

export function cookieValue(cookies: Cookies, name: string): string {
  const value = cookies.get(name);
  return value === null ? "" : value;
}

/**
 * The cookies sent to surface decisions as `http.cookies`, as the upstream proxy's
 * `surfaceDecisionsCookies`: request cookies whose name matches a pattern, then the origin's
 * Set-Cookie values, which win. Null when nothing matches, so the field is left out. A malformed
 * pattern aborts (D6).
 */
export function selectDecisionCookies(patterns: string[], cookies: Cookies, setCookies: string[]): Map<string, string> | null {
  if (patterns.length == 0) return null;
  const res: RegExp[] = [];
  for (let i = 0; i < patterns.length; i++) res.push(new RegExp(patterns[i]));

  const selected = new Map<string, string>();
  const entries = cookies.entries();
  for (let i = 0; i < entries.length; i++) {
    if (matchesAny(res, entries[i][0])) selected.set(entries[i][0], decodeCookieValue(entries[i][1]));
  }
  for (let i = 0; i < setCookies.length; i++) {
    const header = setCookies[i];
    const semi = header.indexOf(";");
    const pair = semi < 0 ? header : header.slice(0, semi);
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = trimSpaces(pair.slice(0, eq));
    if (name.length > 0 && matchesAny(res, name)) selected.set(name, decodeCookieValue(trimSpaces(pair.slice(eq + 1))));
  }
  return selected.size > 0 ? selected : null;
}

/**
 * The decoded value of the first Set-Cookie named `name`, or null when none is. An empty value
 * (an expiry, say) still counts as set, as core's `getExistingCookies` treats it.
 */
export function setCookieValue(setCookies: string[], name: string): string | null {
  for (let i = 0; i < setCookies.length; i++) {
    const header = setCookies[i];
    const semi = header.indexOf(";");
    const pair = semi < 0 ? header : header.slice(0, semi);
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (trimSpaces(pair.slice(0, eq)) == name) return decodeCookieValue(trimSpaces(pair.slice(eq + 1)));
  }
  return null;
}

function matchesAny(res: RegExp[], name: string): bool {
  for (let i = 0; i < res.length; i++) {
    if (res[i].test(name)) return true;
  }
  return false;
}

/** Spaces and tabs only, as the `cookie` package trims. */
function trimSpaces(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (s.charCodeAt(start) == 0x20 || s.charCodeAt(start) == 0x09)) start++;
  while (end > start && (s.charCodeAt(end - 1) == 0x20 || s.charCodeAt(end - 1) == 0x09)) end--;
  return s.slice(start, end);
}

/**
 * decodeURIComponent, or the value as given when it is malformed, as the `cookie` package does.
 * AssemblyScript's decodeURIComponent aborts on bad input, so each run of escapes is checked first.
 */
export function decodeCookieValue(value: string): string {
  if (value.indexOf("%") < 0) return value;
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value.charCodeAt(i) != 0x25) {
      out += value.charAt(i);
      i++;
      continue;
    }
    // A UTF-8 sequence cannot span a literal character, so each run of escapes decodes alone.
    const run = new Array<u8>();
    while (i < value.length && value.charCodeAt(i) == 0x25) {
      if (i + 2 >= value.length) return value;
      const hi = hexValue(value.charCodeAt(i + 1));
      const lo = hexValue(value.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) return value;
      run.push(<u8>((hi << 4) | lo));
      i += 3;
    }
    if (!isValidUtf8(run)) return value;
    const buf = new Uint8Array(run.length);
    for (let k = 0; k < run.length; k++) buf[k] = run[k];
    out += String.UTF8.decode(buf.buffer);
  }
  return out;
}

function hexValue(c: i32): i32 {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

/** Strict UTF-8, as decodeURIComponent requires: no overlongs, surrogates or code points above U+10FFFF. */
function isValidUtf8(b: Array<u8>): bool {
  let i = 0;
  while (i < b.length) {
    const c = <i32>b[i];
    let n = 0;
    let min = 0;
    if (c < 0x80) { i++; continue; }
    if (c >= 0xc2 && c <= 0xdf) { n = 1; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { n = 2; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { n = 3; min = 0x10000; }
    else return false;
    if (i + n >= b.length) return false;
    let cp = c & (0x3f >> n);
    for (let k = 1; k <= n; k++) {
      const cc = <i32>b[i + k];
      if ((cc & 0xc0) != 0x80) return false;
      cp = (cp << 6) | (cc & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += n + 1;
  }
  return true;
}
