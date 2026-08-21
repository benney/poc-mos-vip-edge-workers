// asyncify.js uses assert() and assert.strictEqual() for internal invariants only.
function assert(condition, message) {
    if (!condition) throw new Error(message || 'assertion failed');
}

assert.ok = assert;
assert.strictEqual = (actual, expected, message) => {
    if (actual !== expected) {
        throw new Error(message || `assertion failed: ${String(actual)} !== ${String(expected)}`);
    }
};
assert.notStrictEqual = (actual, expected, message) => {
    if (actual === expected) {
        throw new Error(message || `assertion failed: ${String(actual)} === ${String(expected)}`);
    }
};

module.exports = assert;
