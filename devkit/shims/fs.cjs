// html-rewriter-wasm reads its .wasm synchronously at import time. In the browser we
// hand back the bytes inlined at build time (see build-web.mjs), so the sync
// `new WebAssembly.Module(...)` still works — which is why this must run in a Web
// Worker, where sync compilation is not capped at 4 KB.
const base64 = require('./lolhtml-wasm.cjs');

let cached = null;

function readFileSync() {
    if (cached) return cached;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    cached = bytes;
    return bytes;
}

module.exports = { readFileSync };
