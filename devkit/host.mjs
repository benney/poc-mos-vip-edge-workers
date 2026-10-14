// A runtime-neutral implementation of the VIP edge-worker host ABI, enough to drive
// the real compiled release.wasm through onClientRequest -> origin -> onOriginResponse,
// then onClientResponse.
// No Node built-ins: runs in Node, a browser, or a Web Worker.
//
// Wire formats (from the SDK's msgpack.ts header):
//   Request meta  [method, url]                          (headers travel via header.*)
//   Response meta [status]
//   FetchReq      [method, url, [[name, value], ...]]
//   FetchRes      [status, [[name, value], ...], errKind|nil, errMsg|nil]
// Packed host returns are (ptr << 32) | len; negative means null/absent.

import { constantTimeEq, hmacSha256, jwtVerifyHs256, sha256 } from './crypto.mjs';

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const DEC16 = new TextDecoder('utf-16le');
// The real host caps concurrency, not count; this only stops a runaway worker looping the devkit.
const MAX_FETCHES_PER_PHASE = 16;

// ---------- msgpack (subset the SDK uses) ----------

export class Writer {
    constructor() { this.bytes = []; }
    array(n) {
        if (n <= 15) this.bytes.push(0x90 | n);
        else this.bytes.push(0xdc, (n >> 8) & 0xff, n & 0xff);
        return this;
    }
    str(s) {
        const b = ENC.encode(s);
        if (b.length <= 31) this.bytes.push(0xa0 | b.length);
        else if (b.length <= 0xff) this.bytes.push(0xd9, b.length);
        else this.bytes.push(0xda, (b.length >> 8) & 0xff, b.length & 0xff);
        for (const byte of b) this.bytes.push(byte);
        return this;
    }
    uint(v) {
        if (v <= 0x7f) this.bytes.push(v);
        else this.bytes.push(0xcd, (v >> 8) & 0xff, v & 0xff);
        return this;
    }
    nil() { this.bytes.push(0xc0); return this; }
    pairs(list) {
        this.array(list.length);
        for (const [name, value] of list) this.array(2).str(name).str(value);
        return this;
    }
    done() { return Uint8Array.from(this.bytes); }
}

export class Reader {
    constructor(bytes) { this.b = bytes; this.p = 0; }
    u8() { return this.b[this.p++]; }
    array() {
        const t = this.u8();
        if ((t & 0xf0) === 0x90) return t & 0x0f;
        if (t === 0xdc) return (this.u8() << 8) | this.u8();
        throw new Error(`msgpack: expected array, got 0x${t.toString(16)}`);
    }
    str() {
        const t = this.u8();
        let n;
        if ((t & 0xe0) === 0xa0) n = t & 0x1f;
        else if (t === 0xd9) n = this.u8();
        else if (t === 0xda) n = (this.u8() << 8) | this.u8();
        else if (t === 0xc0) return null;
        else throw new Error(`msgpack: expected str, got 0x${t.toString(16)}`);
        const s = DEC.decode(this.b.subarray(this.p, this.p + n));
        this.p += n;
        return s;
    }
    uint() {
        const t = this.u8();
        if (t <= 0x7f) return t;
        if (t === 0xcd) return (this.u8() << 8) | this.u8();
        throw new Error(`msgpack: expected uint, got 0x${t.toString(16)}`);
    }
    pairs() {
        const n = this.array();
        const out = [];
        for (let i = 0; i < n; i++) { this.array(); out.push([this.str(), this.str()]); }
        return out;
    }
}

// ---------- header map (multi-valued, lowercase names) ----------

export class HeaderMap {
    constructor(pairs = []) { this.list = pairs.map(([n, v]) => [n.toLowerCase(), v]); }
    get(name) {
        const n = name.toLowerCase();
        const hit = this.list.find((e) => e[0] === n);
        return hit ? hit[1] : null;
    }
    set(name, value) {
        const n = name.toLowerCase();
        this.list = this.list.filter((e) => e[0] !== n);
        this.list.push([n, value]);
    }
    append(name, value) { this.list.push([name.toLowerCase(), value]); }
    delete(name) {
        const n = name.toLowerCase();
        this.list = this.list.filter((e) => e[0] !== n);
    }
    entries() { return this.list.map(([n, v]) => [n, v]); }
    getAll(name) {
        const n = name.toLowerCase();
        return this.list.filter((e) => e[0] === n).map((e) => e[1]);
    }
}

export const RULE = {
    0x01: 'insertBefore', 0x02: 'insertAfter', 0x03: 'prependInside', 0x04: 'appendInside',
    0x05: 'replace', 0x06: 'remove', 0x10: 'setAttr', 0x11: 'removeAttr',
    0x12: 'rewriteAttrRe', 0x20: 'setText',
};

// ---------- the host ----------

export class EdgeWorkerHost {
    /**
     * @param wasm              compiled worker bytes (ArrayBuffer | Uint8Array)
     * @param opts.env          host env vars for getenv
     * @param opts.fetchHandler async ({method,url,headers,body}) => {status,headers,body} | {errorKind}
     * @param opts.now         seconds since epoch for JWT `exp` checks; fixed value keeps tests stable
     */
    constructor(wasm, opts = {}) {
        this.wasmBytes = wasm;
        this.env = opts.env ?? {};
        this.now = opts.now ?? null;
        this.fetchHandler = opts.fetchHandler ?? (() => ({ errorKind: 'transport', errorMessage: 'no handler' }));
        this.log = [];
        this.pendingFetches = [];
        this.phase = null;
        // Host-backed stores, shared across requests as they are on the edge.
        this.kv = opts.kv ?? new Map();
        this.limiters = opts.limiters ?? new Map();
    }

    async init() {
        const { instance } = await WebAssembly.instantiate(this.wasmBytes, this.imports());
        this.instance = instance;
        this.ex = instance.exports;
        this.arenaBase = this.ex.alloc(2 * 1024 * 1024);
        return this;
    }

    get mem() { return this.ex.memory.buffer; }
    resetArena() { this.arenaOff = 0; }
    put(bytes) {
        const ptr = this.arenaBase + this.arenaOff;
        new Uint8Array(this.mem, ptr, bytes.length).set(bytes);
        this.arenaOff += bytes.length + (8 - (bytes.length % 8));
        return ptr;
    }
    packed(bytes) { return (BigInt(this.put(bytes)) << 32n) | BigInt(bytes.length); }
    packedStr(s) { return this.packed(ENC.encode(s)); }
    readUtf8(ptr, len) { return DEC.decode(new Uint8Array(this.mem, ptr, len)); }
    readAS(ptr) {
        if (!ptr) return '(null)';
        const n = new Uint32Array(this.mem)[(ptr - 4) >>> 2];
        return DEC16.decode(new Uint8Array(this.mem, ptr, n));
    }

    imports() {
        const h = this;
        const str = (p, l) => h.readUtf8(p, l);
        return {
            env: {
                abort(msg, file, line, col) {
                    throw new Error(`worker abort: ${h.readAS(msg)} in ${h.readAS(file)} @ ${line}:${col}`);
                },
                env_get(namePtr, nameLen) {
                    const name = str(namePtr, nameLen);
                    if (!(name in h.env)) return -1n;
                    return h.packedStr(h.env[name]);
                },
                fetch(metaPtr, metaLen, bodyPtr, bodyLen) {
                    // The host allows fetch() in every phase (SDK main, 2026-10-13).
                    const r = new Reader(new Uint8Array(h.mem, metaPtr, metaLen));
                    r.array();
                    const call = {
                        method: r.str(),
                        url: r.str(),
                        headers: r.pairs(),
                        body: bodyLen > 0 ? h.readUtf8(bodyPtr, bodyLen) : null,
                    };

                    const slot = h.replayQueue.shift();
                    if (!slot) {
                        // Not resolved yet. Record the first such call; a benign error makes the
                        // worker bail out rather than act on invented data, and the pass reruns.
                        if (h.pendingFetches.length === 0) h.pendingFetches.push({ call });
                        return h.packFetchResult(
                            new Writer().array(4).uint(0).pairs([]).str('transport').str('probe').done(), null);
                    }
                    h.log.push({ type: 'fetch', call, result: slot.result });
                    const res = slot.result;
                    if (res.errorKind) {
                        return h.packFetchResult(
                            new Writer().array(4).uint(0).pairs([]).str(res.errorKind).str(res.errorMessage ?? '').done(), null);
                    }
                    const meta = new Writer().array(4).uint(res.status).pairs(res.headers ?? []).nil().nil().done();
                    return h.packFetchResult(meta, res.body == null ? null : ENC.encode(res.body));
                },
            },
            header: {
                get(np, nl) {
                    const v = h.live.get(str(np, nl));
                    return v === null ? -1n : h.packedStr(v);
                },
                set(np, nl, vp, vl) { h.live.set(str(np, nl), str(vp, vl)); return 0; },
                append(np, nl, vp, vl) { h.live.append(str(np, nl), str(vp, vl)); return 0; },
                delete(np, nl) { h.live.delete(str(np, nl)); return 0; },
                list() { return h.packed(new Writer().pairs(h.live.entries()).done()); },
            },
            request: {
                method() { return h.snapshot ? h.packedStr(h.snapshot.method) : -1n; },
                uri() { return h.snapshot ? h.packedStr(h.snapshot.url) : -1n; },
                header_get(np, nl) {
                    if (!h.snapshot) return -1n;
                    const v = h.snapshot.headers.get(str(np, nl));
                    return v === null ? -1n : h.packedStr(v);
                },
                header_list() {
                    if (!h.snapshot) return -1n;
                    return h.packed(new Writer().pairs(h.snapshot.headers.entries()).done());
                },
            },
            response: {
                header_set(np, nl, vp, vl) { h.responded.headers.set(str(np, nl), str(vp, vl)); return 0; },
                header_append(np, nl, vp, vl) { h.responded.headers.append(str(np, nl), str(vp, vl)); return 0; },
                respond(status, bodyPtr, bodyLen) {
                    h.responded.status = status;
                    h.responded.body = bodyLen > 0 ? h.readUtf8(bodyPtr, bodyLen) : null;
                    h.responded.sent = true;
                    return 0;
                },
            },
            html: {
                apply_rewrite_rules(ptr, len) {
                    const r = new Reader(new Uint8Array(h.mem, ptr, len));
                    const count = r.array();
                    for (let i = 0; i < count; i++) {
                        const fields = r.array();
                        const kind = r.uint();
                        const selector = r.str();
                        const args = [];
                        for (let j = 0; j < fields - 2; j++) args.push(r.str());
                        const op = RULE[kind];
                        if (!op) return 3; // bad wire format
                        h.htmlRules.push({ op, selector, args });
                    }
                    return 0;
                },
            },
            // The guest allocates the output buffer and passes its pointer; digests are
            // written straight into wasm memory.
            crypto: {
                sha256(msgPtr, msgLen, outPtr) {
                    const digest = sha256(new Uint8Array(h.mem, msgPtr, msgLen).slice());
                    new Uint8Array(h.mem, outPtr, 32).set(digest);
                    return 0;
                },
                hmac_sha256(keyPtr, keyLen, msgPtr, msgLen, outPtr) {
                    const key = new Uint8Array(h.mem, keyPtr, keyLen).slice();
                    const msg = new Uint8Array(h.mem, msgPtr, msgLen).slice();
                    new Uint8Array(h.mem, outPtr, 32).set(hmacSha256(key, msg));
                    return 0;
                },
                constant_time_eq(aPtr, aLen, bPtr, bLen) {
                    const a = new Uint8Array(h.mem, aPtr, aLen).slice();
                    const b = new Uint8Array(h.mem, bPtr, bLen).slice();
                    return constantTimeEq(a, b) ? 1 : 0;
                },
                jwt_verify_hs256(tokenPtr, tokenLen, secretPtr, secretLen) {
                    const token = str(tokenPtr, tokenLen);
                    const secret = str(secretPtr, secretLen);
                    const claims = h.now === null
                        ? jwtVerifyHs256(token, secret)
                        : jwtVerifyHs256(token, secret, h.now);
                    return claims === null ? -1n : h.packedStr(claims);
                },
            },
            // In-memory KV and rate limiters. Keys are capped at 64 B and values at
            // 10 KiB, as the host documents, so an oversize write fails here too.
            kv: {
                get(keyPtr, keyLen) {
                    const entry = h.kv.get(str(keyPtr, keyLen));
                    if (entry === undefined || entry.kind !== 'bytes') return -1n;
                    return h.packed(entry.value);
                },
                set(keyPtr, keyLen, valPtr, valLen) {
                    const key = str(keyPtr, keyLen);
                    if (ENC.encode(key).length > 64 || valLen > 10 * 1024) return -1;
                    h.kv.set(key, { kind: 'bytes', value: new Uint8Array(h.mem, valPtr, valLen).slice() });
                    return 0;
                },
                delete(keyPtr, keyLen) { h.kv.delete(str(keyPtr, keyLen)); return 0; },
                counter_get(keyPtr, keyLen) {
                    const entry = h.kv.get(str(keyPtr, keyLen));
                    if (entry === undefined) return 0n;
                    if (entry.kind !== 'counter') return -1n; // type mismatch throws host-side
                    return entry.value;
                },
                counter_set(keyPtr, keyLen, value) {
                    const key = str(keyPtr, keyLen);
                    if (ENC.encode(key).length > 64) return -1;
                    h.kv.set(key, { kind: 'counter', value: BigInt(value) });
                    return 0;
                },
                incr(keyPtr, keyLen, delta) {
                    const key = str(keyPtr, keyLen);
                    if (ENC.encode(key).length > 64) return -1n;
                    const entry = h.kv.get(key);
                    if (entry !== undefined && entry.kind !== 'counter') return -1n;
                    const next = (entry?.value ?? 0n) + BigInt(delta);
                    h.kv.set(key, { kind: 'counter', value: next });
                    return next;
                },
                rate_register(namePtr, nameLen, rps) {
                    const name = str(namePtr, nameLen);
                    if (rps <= 0 || ENC.encode(name).length > 64) return -1;
                    // First registration wins, as documented.
                    if (!h.limiters.has(name)) h.limiters.set(name, { rps, buckets: new Map() });
                    return 0;
                },
                rate_check(namePtr, nameLen, keyPtr, keyLen) {
                    const limiter = h.limiters.get(str(namePtr, nameLen));
                    if (!limiter) return -1; // unregistered limiter throws host-side
                    const key = str(keyPtr, keyLen);
                    const used = limiter.buckets.get(key) ?? 0;
                    // No wall clock: a fixed budget per key, enough to exercise the branch.
                    if (used >= limiter.rps) return 0;
                    limiter.buckets.set(key, used + 1);
                    return 1;
                },
            },
        };
    }

    packFetchResult(meta, body) {
        const bodyLen = body ? body.length : 0;
        const buf = new Uint8Array(4 + meta.length + 4 + bodyLen);
        const dv = new DataView(buf.buffer);
        dv.setUint32(0, meta.length, true);
        buf.set(meta, 4);
        dv.setUint32(4 + meta.length, bodyLen, true);
        if (body) buf.set(body, 8 + meta.length);
        return (BigInt(this.put(buf)) << 32n) | BigInt(buf.length);
    }

    readOutputStruct(packedPtr) {
        const ptr = Number(packedPtr);
        const dv = new DataView(this.mem);
        return {
            metaPtr: dv.getUint32(ptr + 4, true),
            metaLen: dv.getUint32(ptr + 8, true),
            bodyPtr: dv.getUint32(ptr + 12, true),
            bodyLen: dv.getUint32(ptr + 16, true),
        };
    }

    /**
     * Runs a phase. fetch() is synchronous inside wasm but our fetchHandler is async,
     * so the phase reruns once per fetch: each pass replays the results resolved so far
     * and stops at the first unresolved call. That covers fetches that depend on an
     * earlier one's response, like posting a fetched page on to an API.
     */
    async runPhase(exportName, meta, body, setup, phase) {
        this.phase = phase;

        // Every pass really executes the worker, so host-side writes from the earlier
        // passes are rolled back and stateful calls land exactly once.
        const kvSnapshot = new Map(this.kv);
        const limiterSnapshot = [...this.limiters].map(([name, l]) => [name, { rps: l.rps, buckets: new Map(l.buckets) }]);

        const resolved = [];
        for (let pass = 0; pass <= MAX_FETCHES_PER_PHASE; pass++) {
            this.kv = new Map(kvSnapshot);
            this.limiters = new Map(limiterSnapshot.map(([name, l]) => [name, { rps: l.rps, buckets: new Map(l.buckets) }]));
            this.replayQueue = [...resolved];
            this.pendingFetches = [];

            setup();
            this.resetArena();
            const out = this.ex[exportName](
                this.put(meta), meta.length, body ? this.put(body) : 0, body ? body.length : 0);

            if (this.pendingFetches.length === 0) {
                if (this.replayQueue.length) throw new Error('worker made fewer fetches on replay');
                return this.readOutputStruct(out);
            }
            resolved.push({ result: await this.fetchHandler(this.pendingFetches[0].call) });
        }
        throw new Error(`worker made more than ${MAX_FETCHES_PER_PHASE} fetches in one phase`);
    }

    async clientRequest({ method = 'GET', url = '/', headers = [], body = null }) {
        const meta = new Writer().array(2).str(method).str(url).done();
        const out = await this.runPhase('on_client_request', meta, body == null ? null : ENC.encode(body), () => {
            this.live = new HeaderMap(headers);
            this.snapshot = null;
            this.responded = { sent: false, status: 0, headers: new HeaderMap(), body: null };
            this.htmlRules = [];
        }, 'client-request');

        if (this.responded.sent) {
            return {
                shortCircuited: true,
                status: this.responded.status,
                headers: this.responded.headers,
                body: this.responded.body,
            };
        }
        const r = new Reader(new Uint8Array(this.mem, out.metaPtr, out.metaLen));
        r.array();
        return {
            shortCircuited: false,
            method: r.str(),
            url: r.str(),
            headers: this.live,
            body: out.bodyLen > 0 ? this.readUtf8(out.bodyPtr, out.bodyLen) : null,
        };
    }

    async originResponse({ status, headers = [], snapshot }) {
        const meta = new Writer().array(1).uint(status).done();
        const out = await this.runPhase('on_origin_response', meta, null, () => {
            this.live = new HeaderMap(headers);
            this.snapshot = { method: snapshot.method, url: snapshot.url, headers: snapshot.headers };
            this.responded = { sent: false, status: 0, headers: new HeaderMap(), body: null };
            this.htmlRules = [];
        }, 'origin-response');
        const r = new Reader(new Uint8Array(this.mem, out.metaPtr, out.metaLen));
        r.array();
        return { status: r.uint(), headers: this.live, rules: this.htmlRules };
    }

    /**
     * Runs onClientResponse on a response from the cache or the origin. `snapshot` is the
     * request before onClientRequest mutated it. The body goes in only when the worker exports
     * client_response_body; whatever body the worker leaves is returned.
     */
    async clientResponse({ status, headers = [], body = null, snapshot }) {
        const buffered = typeof this.ex.client_response_body === 'function';
        const meta = new Writer().array(1).uint(status).done();
        const out = await this.runPhase('on_client_response', meta, buffered && body != null ? ENC.encode(body) : null, () => {
            this.live = new HeaderMap(headers);
            this.snapshot = { method: snapshot.method, url: snapshot.url, headers: snapshot.headers instanceof HeaderMap ? snapshot.headers : new HeaderMap(snapshot.headers) };
            this.responded = { sent: false, status: 0, headers: new HeaderMap(), body: null };
            this.htmlRules = [];
        }, 'client-response');
        const r = new Reader(new Uint8Array(this.mem, out.metaPtr, out.metaLen));
        r.array();
        return {
            status: r.uint(),
            headers: this.live,
            rules: this.htmlRules,
            body: out.bodyLen > 0 ? this.readUtf8(out.bodyPtr, out.bodyLen) : body,
        };
    }
}
