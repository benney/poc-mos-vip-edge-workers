// Runs the *bundled browser worker* under a simulated Web Worker environment, so the
// shims, the inlined wasm, and the full pipeline are all exercised as the
// browser would run them. Not a substitute for opening the page, but it proves the
// bundle is functional rather than merely built.
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { PRESETS } from '../playground/presets.mjs';

const wasm = readFileSync(new URL('../playground/dist/release.wasm', import.meta.url));
const bundle = readFileSync(new URL('../playground/dist/worker.js', import.meta.url), 'utf8');

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

const header = (r, name) => r.final.headers.find(([n]) => n === name)?.[1];
const setCookies = (r) => r.final.headers.filter(([n]) => n === 'set-cookie').map(([, v]) => v);
const sentHeader = (call, name) => call.headers.find(([n]) => n.toLowerCase() === name)?.[1];

// The version the worker reports is the ported core's, when package.json names one.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const portedCoreVersion = pkg.config?.portedCoreVersion;

console.log('\nbundled worker: whole-body paywall');
{
    const preset = PRESETS['Whole-body paywall'];
    const r = await run('Whole-body paywall');
    ok('page replaced', r.outcome === 'replaced', r.outcome);
    ok('one MOS call', r.mosCalls.length === 1);
    ok('status kept', r.final.status === 200, String(r.final.status));
    ok('MOS body served with the paywall', r.final.body === preset.decisions.surfaceBehavior.http.body && r.final.body.includes('class="paywall"'));
    ok('promo from MOS served', r.final.body.includes('<aside class="promo">Subscribe for full access</aside>'));
    ok('original second paragraph gone', !r.final.body.includes('second paragraph'));
    const call = r.mosCalls[0].call;
    ok('called surface-decisions', call.url === 'https://api.mos.test/api/v1/surface-decisions', call.url);
    ok('page sent to MOS as http.proxyOrigin.body', JSON.parse(call.body).http.proxyOrigin.body === preset.origin.body);
    ok('origin status sent to MOS', JSON.parse(call.body).http.proxyOrigin.status === 200);
    ok('whole-body client header', sentHeader(call, 'x-mos-proxy-client') === 'vip-edge-worker-whole-body-poc', sentHeader(call, 'x-mos-proxy-client'));
    const version = sentHeader(call, 'x-mos-proxy-version');
    ok('proxy version header', portedCoreVersion ? version === portedCoreVersion : /^\d+\.\d+\.\d+$/.test(version ?? ''), String(version));
    ok('anon cookie set', setCookies(r).some((v) => v.includes('anon-7f3a')));
    ok('reader copy private', header(r, 'cache-control') === 'private, no-store');
    ok('no rules', r.rules.length === 0);
}

console.log('\nbundled worker: workflow response (402)');
{
    const r = await run('Workflow response (402)');
    ok('page replaced', r.outcome === 'replaced', r.outcome);
    ok('status 402', r.final.status === 402);
    ok('workflow body served', r.final.body.includes('Subscribe to continue reading'));
    ok('no origin html leaked', !r.final.body.includes('first paragraph'));
    ok('workflow header set', header(r, 'x-mos-paywall') === 'blocked');
    ok('workflow cookie set', setCookies(r).includes('mos_wall=1; Path=/'));
    ok('reader copy private', header(r, 'cache-control') === 'private, no-store');
    ok('no rules', r.rules.length === 0);
}

console.log('\nbundled worker: header + status only');
{
    const preset = PRESETS['Header + status only'];
    const r = await run('Header + status only');
    ok('page served as fetched', r.final.body === preset.origin.body);
    ok('not reported as replaced', r.outcome === 'passed through', r.outcome);
    ok('status overridden to 451', r.final.status === 451);
    ok('etag removed', !r.final.headers.some(([n]) => n === 'etag'));
    ok('header added', header(r, 'x-mos-region') === 'blocked');
    ok('extra cookie set', setCookies(r).includes('mos_geo=eu; Path=/'));
    ok('origin cookie kept', setCookies(r).includes('wp_session=abc; Path=/'));
    ok('anon cookie set', setCookies(r).some((v) => v.includes('anon-7f3a')));
    ok('reader copy private', header(r, 'cache-control') === 'private, no-store');
    ok('no rules', r.rules.length === 0);
}

console.log('\nbundled worker: compressed page');
{
    const preset = PRESETS['Compressed page'];
    const r = await run('Compressed page');
    ok('no MOS call', r.mosCalls.length === 0);
    ok('page served as it is', r.final.body === preset.origin.body && r.final.status === 200);
    ok('not made private', header(r, 'cache-control') === undefined);
    ok('no rules', r.rules.length === 0);
}

console.log('\nbundled worker: custom endpoint');
{
    const r = await run('Custom endpoint');
    ok('short-circuited', r.outcome === 'short-circuited');
    ok('rewritten to envs/endpoints', r.mosCalls[0].call.url.includes('/api/v1/envs/demo_ab12cd/endpoints/subscribe?plan=gold'), r.mosCalls[0].call.url);
    ok('client body forwarded', r.mosCalls[0].call.body === '{"email":"reader@example.com"}');
    ok('no rules', r.rules.length === 0);
}

console.log('\nbundled worker: authenticated route');
{
    const r = await run('Authenticated route (JWT)');
    const sent = JSON.parse(r.mosCalls[0].call.body);
    ok('called mapped path', r.mosCalls[0].call.url.endsWith('/api/v1/checkout'));
    ok('JWT forwarded', sent.identity.userJwt === 'head.body.sig');
    ok('client body merged', sent.plan === 'gold');
    ok('http metadata sent', sent.http.url.endsWith('/wp-json/mos/checkout'), sent.http.url);
    ok('no rules', r.rules.length === 0);
}

console.log('\nbundled worker: fail open + gating');
{
    let r = await run('Fail open (API down)');
    ok('origin html untouched', r.final.body === PRESETS['Fail open (API down)'].origin.body);
    ok('origin status kept', r.final.status === 200);
    ok('no anon cookie', !setCookies(r).some((v) => v.includes('anon-7f3a')));
    ok('not made private', header(r, 'cache-control') === undefined);
    ok('no rules', r.rules.length === 0);

    r = await run('Ignored path');
    ok('no MOS call for ignored path', r.mosCalls.length === 0);
    ok('page served as fetched', r.final.body === PRESETS['Ignored path'].origin.body);
    ok('no rules', r.rules.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
