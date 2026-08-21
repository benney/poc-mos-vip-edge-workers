// Runs the *bundled browser worker* under a simulated Web Worker environment, so the
// shims, the inlined lol-html wasm, and the full pipeline are all exercised as the
// browser would run them. Not a substitute for opening the page, but it proves the
// bundle is functional rather than merely built.
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { PRESETS } from './presets.mjs';

const wasm = readFileSync(new URL('../web/dist/release.wasm', import.meta.url));
const bundle = readFileSync(new URL('../web/dist/worker.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
};

const messages = [];
const waiters = [];
const fakeSelf = {
    location: { href: 'http://localhost:8787/worker.js' },
    postMessage(msg) {
        const waiter = waiters.shift();
        if (waiter) waiter(msg);
        else messages.push(msg);
    },
    onmessage: null,
};
const nextMessage = () => new Promise((resolve) => {
    if (messages.length) return resolve(messages.shift());
    waiters.push(resolve);
});

globalThis.self = fakeSelf;
globalThis.fetch = async (url) => {
    if (String(url).endsWith('release.wasm')) {
        return { ok: true, status: 200, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) };
    }
    throw new Error(`unexpected fetch: ${url}`);
};

// Evaluate the IIFE bundle exactly as a worker would. runInThisContext avoids Node's
// CJS/ESM format detection, which new Function() applies to the source string.
runInThisContext(bundle);

const ready = await nextMessage();
ok('worker signals ready', ready.type === 'ready', JSON.stringify(ready));
ok('release.wasm loaded through fetch', ready.wasmBytes === wasm.byteLength, `got ${ready.wasmBytes}`);

async function run(name) {
    const preset = PRESETS[name];
    fakeSelf.onmessage({ data: { type: 'run', id: 1, input: {
        env: preset.env,
        request: preset.request,
        origin: preset.origin,
        decisions: preset.decisions,
        failDecisions: preset.failDecisions,
    } } });
    const msg = await nextMessage();
    if (msg.type === 'error') throw new Error(`${name}: ${msg.message}\n${msg.stack ?? ''}`);
    return msg.result;
}

console.log('\nbundled worker: component injection');
{
    const r = await run('Component injection');
    ok('rewritten', r.outcome === 'rewritten', r.outcome);
    ok('one MOS call', r.mosCalls.length === 1);
    ok('plan header produced', typeof r.planHeader === 'string' && r.planHeader.length > 0);
    // Proves the inlined lol-html actually parsed and rewrote the HTML.
    ok('lol-html injected promo', r.final.body.includes('<aside class="promo">Subscribe for full access</aside><article'));
    ok('lol-html injected web component', r.final.body.includes('<mos-paywall version="2"'));
    ok('lol-html removed house ad', !r.final.body.includes('Generic house ad'));
    ok('lol-html injected script into head', r.final.body.includes('cdn.mos.test/mos.js'));
    ok('anon cookie set', r.final.headers.some(([n, v]) => n === 'set-cookie' && v.includes('anon-7f3a')));
    ok('no-store applied', r.final.headers.some(([n, v]) => n === 'cache-control' && v === 'no-store'));
}

console.log('\nbundled worker: paywall hard block');
{
    const r = await run('Paywall hard block');
    ok('short-circuited', r.outcome === 'short-circuited');
    ok('origin not contacted', r.reachedOrigin === false);
    ok('status 402', r.final.status === 402);
    ok('replacement body served', r.final.body.includes('Subscribe to continue reading'));
    ok('no origin html leaked', !r.final.body.includes('first paragraph'));
}

console.log('\nbundled worker: custom endpoint');
{
    const r = await run('Custom endpoint');
    ok('short-circuited', r.outcome === 'short-circuited');
    ok('rewritten to envs/endpoints', r.mosCalls[0].call.url.includes('/api/v1/envs/test_ab12cd/endpoints/subscribe?plan=gold'));
    ok('client body forwarded', r.mosCalls[0].call.body === '{"email":"reader@example.com"}');
}

console.log('\nbundled worker: authenticated route');
{
    const r = await run('Authenticated route (JWT)');
    const sent = JSON.parse(r.mosCalls[0].call.body);
    ok('called mapped path', r.mosCalls[0].call.url.endsWith('/api/v1/checkout'));
    ok('JWT forwarded', sent.identity.userJwt === 'head.body.sig');
    ok('client body merged', sent.plan === 'gold');
}

console.log('\nbundled worker: fail open + gating');
{
    let r = await run('Fail open (API down)');
    ok('origin html untouched', r.final.body === PRESETS['Fail open (API down)'].origin.body);
    ok('no rules', r.rules.length === 0);

    r = await run('Ignored path');
    ok('no MOS call for ignored path', r.mosCalls.length === 0);

    r = await run('Header + status only');
    ok('status overridden to 451', r.final.status === 451);
    ok('etag removed', !r.final.headers.some(([n]) => n === 'etag'));
    ok('html still rewritten', r.final.body.includes('Unavailable in your region.'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
