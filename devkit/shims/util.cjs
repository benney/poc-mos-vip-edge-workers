// html-rewriter-wasm does `require('util')` purely for these two globals.
module.exports = {
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
};
