// Wire-format conformance harness. Not a deployable worker.
//
// devkit/host.mjs reimplements the SDK's msgpack encoding in JavaScript, because the
// SDK's codec is AssemblyScript and cannot be imported into Node. That duplication is
// invisible: if the SDK changes its encoding, the devkit keeps passing its own tests
// while diverging from the runtime.
//
// This module exposes the SDK's *own* MsgpackWriter and MsgpackReader over a byte ABI,
// so check.mjs can assert both directions against them. A wire-format change in the SDK
// then fails this test instead of silently desyncing.
import { MsgpackReader, MsgpackWriter } from "@automattic/vip-edge-workers-sdk/assembly/msgpack";

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

function setOutBytes(buf: ArrayBuffer): void {
  const b = Uint8Array.wrap(buf);
  keep.push(b);
  outPtrV = b.dataStart;
  outLenV = b.byteLength;
}
function setOutText(s: string): void {
  const b = Uint8Array.wrap(String.UTF8.encode(s));
  keep.push(b);
  outPtrV = b.dataStart;
  outLenV = b.byteLength;
}

// --- encode with the SDK's writer, for the JS reader to decode ---

/** Request meta as the ABI layer packs it: [method, url]. */
export function encodeRequestMeta(mPtr: usize, mLen: i32, uPtr: usize, uLen: i32): void {
  const w = new MsgpackWriter();
  w.writeArray(2);
  w.writeStr(String.UTF8.decodeUnsafe(mPtr, mLen));
  w.writeStr(String.UTF8.decodeUnsafe(uPtr, uLen));
  setOutBytes(w.toArrayBuffer());
}

/** Response meta: [status]. */
export function encodeResponseMeta(status: i32): void {
  const w = new MsgpackWriter();
  w.writeArray(1);
  w.writeUint16(<u16>status);
  setOutBytes(w.toArrayBuffer());
}

/** A header pair array, as header.list returns. */
export function encodePairs(pPtr: usize, pLen: i32): void {
  // Input is "name\tvalue\n"-joined so the harness needs no JSON.
  const text = String.UTF8.decodeUnsafe(pPtr, pLen);
  const pairs: string[][] = [];
  if (text.length > 0) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length == 0) continue;
      const parts = lines[i].split("\t");
      pairs.push([parts[0], parts.length > 1 ? parts[1] : ""]);
    }
  }
  const w = new MsgpackWriter();
  w.writeStrPairArray(pairs);
  setOutBytes(w.toArrayBuffer());
}

/** A string of n bytes, to cross the 31/255-byte prefix boundaries. */
export function encodeStrOfLength(n: i32): void {
  let s = "";
  for (let i = 0; i < n; i++) s += "a";
  const w = new MsgpackWriter();
  w.writeArray(1);
  w.writeStr(s);
  setOutBytes(w.toArrayBuffer());
}

/** An array of n empty-string entries, to cross the 15-element boundary. */
export function encodeArrayOfLength(n: i32): void {
  const w = new MsgpackWriter();
  w.writeArray(n);
  for (let i = 0; i < n; i++) w.writeStr("");
  setOutBytes(w.toArrayBuffer());
}

/** FetchRes shape: [status, pairs, errKind|nil, errMsg|nil]. */
export function encodeFetchResponse(status: i32, withError: i32): void {
  const w = new MsgpackWriter();
  w.writeArray(4);
  w.writeUint16(<u16>status);
  w.writeStrPairArray([["content-type", "application/json"]]);
  if (withError == 1) { w.writeStrOrNil("timeout"); w.writeStrOrNil("took too long"); }
  else { w.writeStrOrNil(null); w.writeStrOrNil(null); }
  setOutBytes(w.toArrayBuffer());
}

// --- decode with the SDK's reader, bytes produced by the JS writer ---

/** Reads [method, url] and reports what the SDK's reader saw. */
export function decodeRequestMeta(ptr: usize, len: i32): void {
  const r = new MsgpackReader(ptr, <usize>len);
  const size = r.readArraySize();
  const method = r.readStr();
  const url = r.readStr();
  setOutText("size=" + size.toString() + "\nmethod=" + method + "\nurl=" + url);
}

/** Reads [status]. */
export function decodeResponseMeta(ptr: usize, len: i32): void {
  const r = new MsgpackReader(ptr, <usize>len);
  const size = r.readArraySize();
  const status = r.readUint16();
  setOutText("size=" + size.toString() + "\nstatus=" + status.toString());
}

/** Reads [method, url, pairs] — the FetchReq the guest sends to the host. */
export function decodeFetchRequest(ptr: usize, len: i32): void {
  const r = new MsgpackReader(ptr, <usize>len);
  const size = r.readArraySize();
  const method = r.readStr();
  const url = r.readStr();
  const pairs = r.readStrPairArray();
  let out = "size=" + size.toString() + "\nmethod=" + method + "\nurl=" + url
    + "\npairs=" + pairs.length.toString();
  for (let i = 0; i < pairs.length; i++) {
    out += "\n" + pairs[i][0] + "\t" + pairs[i][1];
  }
  setOutText(out);
}

/** Reads a bare pair array. */
export function decodePairs(ptr: usize, len: i32): void {
  const r = new MsgpackReader(ptr, <usize>len);
  const pairs = r.readStrPairArray();
  let out = "pairs=" + pairs.length.toString();
  for (let i = 0; i < pairs.length; i++) out += "\n" + pairs[i][0] + "\t" + pairs[i][1];
  setOutText(out);
}
