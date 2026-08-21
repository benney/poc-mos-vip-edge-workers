// SHA-256 / HMAC-SHA256 / HS256 JWT for the host's `crypto.*` functions.
//
// Deliberately pure JS and synchronous: the SDK's crypto host calls return values
// directly, and WebCrypto is async-only, so it cannot back them in the browser
// playground. Small enough to audit, no dependencies.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** @param {Uint8Array} msg @returns {Uint8Array} 32-byte digest */
export function sha256(msg) {
    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);

    // Pad to a multiple of 64: 0x80, zeros, then a 64-bit big-endian bit length.
    const bitLen = msg.length * 8;
    const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
    padded.set(msg);
    padded[msg.length] = 0x80;
    const dv = new DataView(padded.buffer);
    // Lengths beyond 2^32 bits are not reachable here; high word stays zero.
    dv.setUint32(padded.length - 4, bitLen >>> 0, false);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296), false);

    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e;
            e = (d + t1) >>> 0;
            d = c; c = b; b = a;
            a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i], false);
    return out;
}

const BLOCK = 64;

/** @param {Uint8Array} key @param {Uint8Array} msg @returns {Uint8Array} 32-byte digest */
export function hmacSha256(key, msg) {
    let k = key.length > BLOCK ? sha256(key) : key;
    const padKey = new Uint8Array(BLOCK);
    padKey.set(k);

    const inner = new Uint8Array(BLOCK + msg.length);
    const outer = new Uint8Array(BLOCK + 32);
    for (let i = 0; i < BLOCK; i++) {
        inner[i] = padKey[i] ^ 0x36;
        outer[i] = padKey[i] ^ 0x5c;
    }
    inner.set(msg, BLOCK);
    outer.set(sha256(inner), BLOCK);
    return sha256(outer);
}

/** Length-independent byte comparison, per the SDK's contract. */
export function constantTimeEq(a, b) {
    let diff = a.length ^ b.length;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
}

const b64urlDecode = (s) => {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
};

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * Verifies alg, signature and `exp`; `nbf`/`iat` are not enforced, matching the
 * documented host behaviour.
 * @returns claims JSON string, or null on any failure
 * @param nowSeconds injectable clock, so tests are not time-dependent
 */
export function jwtVerifyHs256(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    let header, payloadText;
    try {
        header = JSON.parse(DEC.decode(b64urlDecode(headerB64)));
        payloadText = DEC.decode(b64urlDecode(payloadB64));
    } catch { return null; }

    if (header?.alg !== 'HS256') return null;

    let sig;
    try { sig = b64urlDecode(sigB64); } catch { return null; }
    const expected = hmacSha256(ENC.encode(secret), ENC.encode(`${headerB64}.${payloadB64}`));
    if (!constantTimeEq(sig, expected)) return null;

    let claims;
    try { claims = JSON.parse(payloadText); } catch { return null; }
    if (typeof claims?.exp === 'number' && claims.exp <= nowSeconds) return null;

    return payloadText;
}
