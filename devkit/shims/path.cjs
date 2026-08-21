// Only used to build the .wasm path, which the fs shim ignores.
module.exports = {
    join: (...parts) => parts.filter(Boolean).join('/'),
};
