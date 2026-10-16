// Node harness: instantiates the compiled test.wasm, stubs the two host imports,
// and decodes the msgpack rule payload the worker submits to html.apply_rewrite_rules.
import { readFileSync } from 'node:fs';

const KIND = { 0x01: 'insertBefore', 0x02: 'insertAfter', 0x03: 'prependInside', 0x04: 'appendInside', 0x05: 'replace', 0x06: 'remove', 0x10: 'setAttr', 0x11: 'removeAttr', 0x12: 'rewriteAttrRe', 0x20: 'setText' };

let installed = [];

function decodeRules(bytes) {
    let p = 0;
    const u8 = () => bytes[p++];
    const arrLen = () => { const b = u8(); if ((b & 0xf0) === 0x90) return b & 0x0f; if (b === 0xdc) { const n = (u8() << 8) | u8(); return n; } throw new Error('bad array ' + b.toString(16)); };
    const str = () => { const b = u8(); let n; if ((b & 0xe0) === 0xa0) n = b & 0x1f; else if (b === 0xd9) n = u8(); else if (b === 0xda) n = (u8() << 8) | u8(); else throw new Error('bad str ' + b.toString(16)); const s = Buffer.from(bytes.slice(p, p + n)).toString('utf8'); p += n; return s; };
    const uint = () => { const b = u8(); if (b <= 0x7f) return b; if (b === 0xcd) return (u8() << 8) | u8(); throw new Error('bad uint ' + b.toString(16)); };

    const count = arrLen();
    const out = [];
    for (let i = 0; i < count; i++) {
        const fields = arrLen();
        const kind = uint();
        const selector = str();
        const args = [];
        for (let j = 0; j < fields - 2; j++) args.push(str());
        out.push({ op: KIND[kind] ?? kind, selector, args });
    }
    return out;
}

const wasm = readFileSync(new URL('../build/mos-proxy/test.wasm', import.meta.url));
let inst;
let envMap = {};
let scratch = { ptr: 0, off: 0 };

const readUtf8 = (ptr, len) => Buffer.from(new Uint8Array(inst.exports.memory.buffer, ptr, len)).toString('utf8');

const imports = {
    env: {
        abort(msgPtr, filePtr, line, col) {
            const readAS = (ptr) => {
                if (!ptr) return '(null)';
                const mem = inst.exports.memory.buffer;
                const byteLen = new Uint32Array(mem)[(ptr - 4) >>> 2];
                return Buffer.from(new Uint8Array(mem, ptr, byteLen)).toString('utf16le');
            };
            throw new Error(`AS abort: ${readAS(msgPtr)} in ${readAS(filePtr)} @ ${line}:${col}`);
        },
        env_get(namePtr, nameLen) {
            const name = readUtf8(namePtr, nameLen);
            if (!(name in envMap)) return -1n;
            const bytes = Buffer.from(envMap[name], 'utf8');
            const ptr = scratch.ptr + scratch.off;
            new Uint8Array(inst.exports.memory.buffer, ptr, bytes.length).set(bytes);
            scratch.off += bytes.length;
            return (BigInt(ptr) << 32n) | BigInt(bytes.length);
        },
        fetch() { throw new Error('fetch should not be reached in these tests'); },
    },
    html: {
        apply_rewrite_rules(ptr, len) {
            const mem = new Uint8Array(inst.exports.memory.buffer, ptr, len);
            installed = decodeRules(Uint8Array.from(mem));
            return 0; // host OK
        },
    },
};

const { instance } = await WebAssembly.instantiate(wasm, imports);
inst = instance;
const ex = instance.exports;

// Scratch region the env_get stub writes values into (avoids re-entering wasm).
scratch.ptr = ex.inAlloc(16 * 1024);

const BASE_ENV = {
    MOS_HOST: 'https://api.monetizationos.com',
    MOS_SURFACE_SLUG: 'news',
    MOS_SECRET_KEY: 'sk_live_ab12cd',
};
const setEnv = (extra = {}) => { envMap = { ...BASE_ENV, ...extra }; scratch.off = 0; };
setEnv();

// Explicit UTF-8 ABI: copy args into wasm memory, read the result back out.
const put = (s) => {
    const bytes = Buffer.from(s, 'utf8');
    const ptr = ex.inAlloc(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
};
const takeOut = () => Buffer.from(new Uint8Array(ex.memory.buffer, ex.outPtr(), ex.outLen())).toString('utf8');
const call = (fn, ...strs) => { const a = strs.flatMap(put); fn(...a); return takeOut(); };
const callInt = (fn, ...strs) => fn(...strs.flatMap(put));

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
};

console.log('\ncookies');
const cookie = (h, n) => call(ex.testReadCookie, h, n);
eq('reads a cookie', cookie('a=1; mos_anon_id=abc123; b=2', 'mos_anon_id'), 'abc123');
eq('tolerates whitespace', cookie('  mos_anon_id = xyz  ', 'mos_anon_id'), 'xyz');
eq('absent -> empty', cookie('a=1', 'mos_anon_id'), '');
eq('empty header -> empty', cookie('', 'mos_anon_id'), '');
eq('no substring match', cookie('xmos_anon_id=nope', 'mos_anon_id'), '');

console.log('\ncookie values (port of the cookie package decode)');
const jsDecode = (v) => { if (!v.includes('%')) return v; try { return decodeURIComponent(v); } catch { return v; } };
const decodeCases = ['plain', 'a%20b', '%E2%82%AC', 'caf%C3%A9 au lait', '%', '%4', '%zz', '%C3', '%C0%AF', '%ED%A0%80', '%F4%90%80%80', 'x%F0%9F%98%80y', '%E2%82', '100%', 'é%20x'];
eq('decodes as decodeURIComponent, keeping malformed values', decodeCases.map((v) => call(ex.testDecodeCookie, v)), decodeCases.map(jsDecode));

console.log('\nresource (port of ResourceProvider merging)');
eq('id is the path', JSON.parse(call(ex.testResourceFor, '/story', '')), { id: '/story' });
eq('extra fields merged over it', JSON.parse(call(ex.testResourceFor, '/story', 'id=post-42\nsection=sport')), { id: 'post-42', section: 'sport' });

console.log('\nidentity (port of buildIdentity)');
const ident = (a, j) => JSON.parse(call(ex.testBuildIdentity, a, j));
eq('jwt wins over anon', ident('anon1', 'jwt1'),
    { createAnonymousIdentifier: false, anonymousIdentifier: null, userJwt: 'jwt1', createAnonymousIdentifierFallback: true });
eq('anon when no jwt', ident('anon1', ''),
    { createAnonymousIdentifier: false, anonymousIdentifier: 'anon1', userJwt: null, createAnonymousIdentifierFallback: false });
eq('mint when neither', ident('', ''),
    { createAnonymousIdentifier: true, anonymousIdentifier: null, userJwt: null, createAnonymousIdentifierFallback: false });

const compile = (decisions, script = '') => JSON.parse(call(ex.testCompilePlan, JSON.stringify(decisions), script));
const apply = (plan) => callInt(ex.testApplyPlan, JSON.stringify(plan));

console.log('\nplan compilation');
const base = { status: 'success', identity: { identifier: 'anon-new', isAuthenticated: false }, componentsSkipped: false, componentBehaviors: {} };

eq('carries minted identifier', compile(base).a, 'anon-new');
eq('injects script into head', compile(base, 'https://cdn.example.com/mos.js').r,
    [{ o: 'ai', s: 'head', h: '<script src="https://cdn.example.com/mos.js" async defer></script>' }]);

eq('componentsSkipped drops component rules', compile({
    ...base,
    componentsSkipped: true,
    componentBehaviors: { paywall: { metadata: { cssSelector: '.article' }, content: { append: [{ type: 'html', content: '<b>x</b>' }] } } },
}).r, []);

eq('before/prepend/append/after', compile({
    ...base,
    componentBehaviors: {
        paywall: {
            metadata: { cssSelector: '.article-body' },
            content: {
                before: [{ type: 'html', content: '<i>B</i>' }],
                prepend: [{ type: 'html', content: '<i>P</i>' }],
                append: [{ type: 'html', content: '<i>A</i>' }],
                after: [{ type: 'html', content: '<i>F</i>' }],
            },
        },
    },
}).r, [
    { o: 'ib', s: '.article-body', h: '<i>B</i>' },
    { o: 'ia', s: '.article-body', h: '<i>F</i>' },
    { o: 'pi', s: '.article-body', h: '<i>P</i>' },
    { o: 'ai', s: '.article-body', h: '<i>A</i>' },
]);

eq('list order preserved in one payload', compile({
    ...base,
    componentBehaviors: { c: { metadata: { cssSelector: '#x' }, content: { after: [{ type: 'html', content: '1' }, { type: 'html', content: '2' }, { type: 'html', content: '3' }] } } },
}).r, [{ o: 'ia', s: '#x', h: '123' }]);

eq('remove -> replace, keeps before/after, drops inside', compile({
    ...base,
    componentBehaviors: {
        c: {
            metadata: { cssSelector: '.gated' },
            content: {
                remove: true,
                before: [{ type: 'html', content: '<promo/>' }],
                prepend: [{ type: 'html', content: 'GONE' }],
                append: [{ type: 'html', content: 'GONE' }],
                after: [{ type: 'html', content: '<foot/>' }],
            },
        },
    },
}).r, [
    { o: 'ib', s: '.gated', h: '<promo/>' },
    { o: 'ia', s: '.gated', h: '<foot/>' },
    { o: 'rp', s: '.gated', h: '' },
]);

eq('text type is escaped', compile({
    ...base,
    componentBehaviors: { c: { metadata: { cssSelector: 'p' }, content: { append: [{ type: 'text', content: '<script>&bad' }] } } },
}).r, [{ o: 'ai', s: 'p', h: '&lt;script&gt;&amp;bad' }]);

eq('element type -> web component tag', compile({
    ...base,
    componentBehaviors: { c: { metadata: { cssSelector: 'p' }, content: { append: [{ type: 'element', schema: 'mos:paywall@2', props: { tier: 'gold', n: 3 } }] } } },
}).r, [{ o: 'ai', s: 'p', h: '<mos-paywall version="2" props="{&quot;tier&quot;:&quot;gold&quot;,&quot;n&quot;:3}"></mos-paywall>' }]);

eq('uppercase type still matches', compile({
    ...base,
    componentBehaviors: { c: { metadata: { cssSelector: 'p' }, content: { append: [{ type: 'HTML', content: '<b/>' }] } } },
}).r, [{ o: 'ai', s: 'p', h: '<b/>' }]);

eq(':last-child selector skipped', compile({
    ...base,
    componentBehaviors: { c: { metadata: { cssSelector: 'div:last-child' }, content: { append: [{ type: 'html', content: 'x' }] } } },
}).r, []);

eq('null cssSelector skipped', compile({
    ...base,
    componentBehaviors: { c: { metadata: {}, content: { append: [{ type: 'html', content: 'x' }] } } },
}).r, []);

eq('unknown element type renders empty (no abort)', compile({
    ...base,
    componentBehaviors: { c: { metadata: { cssSelector: 'p' }, content: { append: [{ type: 'mystery' }] } } },
}).r, []);

console.log('\nHtmlRules replay (decoded msgpack sent to host)');
installed = [];
const applied = apply(({
    a: 'anon-1',
    r: [
        { o: 'ib', s: '.a', h: '<x/>' },
        { o: 'pi', s: 'head', h: '<script/>' },
        { o: 'rp', s: '.gated', h: '' },
        { o: 'zz', s: '.bad', h: 'ignored' },
    ],
}));
eq('applied count skips unknown op', applied, 3);
eq('msgpack rules match', installed, [
    { op: 'insertBefore', selector: '.a', args: ['<x/>'] },
    { op: 'prependInside', selector: 'head', args: ['<script/>'] },
    { op: 'replace', selector: '.gated', args: [''] },
]);

installed = [];
eq('empty plan installs nothing', apply({ a: '', r: [] }), 0);
eq('no host call on empty plan', installed, []);

// 300 rules > MAX_RULES 200
installed = [];
const many = { a: '', r: Array.from({ length: 300 }, (_, i) => ({ o: 'ai', s: `#n${i}`, h: 'x' })) };
eq('rule count capped at 200', apply(many), 200);
eq('host received exactly 200', installed.length, 200);

// oversize payload must stop before the 64 KiB host limit
installed = [];
const big = { a: '', r: Array.from({ length: 40 }, (_, i) => ({ o: 'ai', s: `#b${i}`, h: 'z'.repeat(4000) })) };
const bigApplied = apply(big);
const bytes = installed.reduce((n, r) => n + r.selector.length + r.args.join('').length, 0);
eq('payload capped under 64 KiB', bytes < 64 * 1024, true);
eq('stopped early rather than aborting', bigApplied < 40, true);

console.log('\nconfig from env vars');
setEnv();
const cfgFields = () => call(ex.testLoadConfig).split('\n');
let f = cfgFields();
eq('valid with required vars', f[0], 'true');
eq('trailing slash trimmed', (setEnv({ MOS_HOST: 'https://api.example.com/' }), cfgFields()[1]), 'https://api.example.com');
setEnv();
eq('environment from secret key', cfgFields()[2], 'live_ab12cd');
eq('default endpoints prefix', cfgFields()[3], '/mos-endpoints/');
eq('default cookie names', [cfgFields()[4], cfgFields()[5]], ['mos_anon_id', 'mos_user_jwt']);
eq('anon fallback defaults true', cfgFields()[6], 'true');

setEnv({ MOS_SECRET_KEY: 'sk_test_zz99' });
eq('test env key', cfgFields()[2], 'test_zz99');

// The API rejects `http` unless the key is a secret one.
eq('sk_ key includes http', cfgFields()[9], 'true');
setEnv({ MOS_SECRET_KEY: 'pk_preview_abc123' });
eq('pk_ token omits http', cfgFields()[9], 'false');
setEnv();

setEnv({ MOS_ENVIRONMENT: 'live_override' });
eq('MOS_ENVIRONMENT overrides derivation', cfgFields()[2], 'live_override');
setEnv({ MOS_ENVIRONMENT: '' });
eq('empty override falls back to derivation', cfgFields()[2], 'live_ab12cd');

setEnv({ MOS_ANON_FALLBACK: 'false' });
eq('anon fallback opt-out', cfgFields()[6], 'false');

setEnv({ MOS_JWT_COOKIE: 'wp_jwt', MOS_ANON_COOKIE: 'wp_anon' });
f = cfgFields();
eq('cookie names overridable', [f[4], f[5]], ['wp_anon', 'wp_jwt']);

setEnv({ MOS_AUTHENTICATED_ROUTES: 'POST /wp-json/mos/checkout>/api/v1/checkout, put /wp-json/mos/profile>/api/v1/profile' });
eq('auth routes parsed, method upcased', cfgFields()[7],
    'POST /wp-json/mos/checkout>/api/v1/checkout|PUT /wp-json/mos/profile>/api/v1/profile');

setEnv({ MOS_AUTHENTICATED_ROUTES: 'GET /nope>/api/v1/nope, POST /ok>/api/v1/ok, garbage, POST /no-arrow, DELETE /d>/x, POST >/empty-match' });
eq('rejects GET/DELETE and malformed entries', cfgFields()[7], 'POST /ok>/api/v1/ok');

setEnv({ MOS_IGNORE_PREFIXES: '/wp-admin, /wp-login.php,', MOS_IGNORE_PATTERNS: '^/feed(/|$)   \\.amp$' });
f = cfgFields();
eq('ignore prefixes split on commas', f[8], '/wp-admin|/wp-login.php');
eq('ignore patterns split on spaces', f[10], '^/feed(/|$) \\.amp$');
setEnv({ MOS_AUTHENTICATED_ROUTES: 'POST />/api/v1/root' });
eq('root matchPath is valid', cfgFields()[7], 'POST />/api/v1/root');
setEnv({ MOS_SURFACE_DECISIONS_COOKIES: '^__session$   ^mos_' });
eq('decision cookie patterns split on spaces', cfgFields()[11], '^__session$ ^mos_');
setEnv();
eq('no decision cookies by default', cfgFields()[11], '');

setEnv({ MOS_SECRET_KEY: '' });
eq('empty secret key -> invalid', cfgFields()[0], 'false');
envMap = { MOS_HOST: 'https://api.example.com' }; scratch.off = 0;
eq('missing slug/key -> invalid', cfgFields()[0], 'false');

console.log('\ncustom endpoints');
setEnv();
const target = (path, query = '') => call(ex.testCustomEndpointTarget, path, query);
eq('rewrites prefix to envs/endpoints path',
    target('/mos-endpoints/checkout'),
    'https://api.monetizationos.com/api/v1/envs/live_ab12cd/endpoints/checkout');
eq('preserves query string',
    target('/mos-endpoints/checkout', '?plan=gold&x=1'),
    'https://api.monetizationos.com/api/v1/envs/live_ab12cd/endpoints/checkout?plan=gold&x=1');
eq('keeps nested path segments',
    target('/mos-endpoints/a/b/c'),
    'https://api.monetizationos.com/api/v1/envs/live_ab12cd/endpoints/a/b/c');
eq('strips duplicated leading slashes',
    target('/mos-endpoints//checkout'),
    'https://api.monetizationos.com/api/v1/envs/live_ab12cd/endpoints/checkout');
eq('bare prefix -> empty endpoint',
    target('/mos-endpoints/'),
    'https://api.monetizationos.com/api/v1/envs/live_ab12cd/endpoints/');
setEnv({ MOS_ENDPOINTS_PREFIX: '/_mos/' });
eq('honours custom prefix',
    target('/_mos/thing'),
    'https://api.monetizationos.com/api/v1/envs/live_ab12cd/endpoints/thing');

console.log('\nauthenticated route matching');
setEnv({ MOS_AUTHENTICATED_ROUTES: 'POST /wp-json/mos/checkout>/api/v1/checkout, PATCH /wp-json/mos/profile>/api/v1/profile' });
const route = (path, method) => call(ex.testMatchRoute, path, method);
eq('exact path + method matches', route('/wp-json/mos/checkout', 'POST'), 'POST /api/v1/checkout');
eq('method is case-insensitive', route('/wp-json/mos/checkout', 'post'), 'POST /api/v1/checkout');
eq('wrong method no match', route('/wp-json/mos/checkout', 'PUT'), '');
eq('prefix is not a match', route('/wp-json/mos/checkout/extra', 'POST'), '');
eq('second route matches', route('/wp-json/mos/profile', 'PATCH'), 'PATCH /api/v1/profile');
eq('unknown path no match', route('/other', 'POST'), '');
setEnv();
eq('no routes configured -> no match', route('/wp-json/mos/checkout', 'POST'), '');

console.log('\nauthenticated route payload (JWT passthrough)');
setEnv();
const merged = (body, cookies, url = 'https://site.test/wp-json/mos/checkout') =>
    JSON.parse(call(ex.testMergeBody, body, cookies, url));

let m = merged('{"plan":"gold","qty":2}', 'mos_user_jwt=eyJhbG.payload.sig; other=1');
eq('sk_ key sends http on authed routes', m.http !== undefined, true);
eq('client body keys preserved', [m.plan, m.qty], ['gold', 2]);
eq('JWT forwarded from cookie', m.identity.userJwt, 'eyJhbG.payload.sig');
eq('JWT sets fallback flag', m.identity.createAnonymousIdentifierFallback, true);
eq('no anon id when JWT present', m.identity.anonymousIdentifier, null);
eq('http metadata attached', m.http.url, 'https://site.test/wp-json/mos/checkout');

m = merged('{"plan":"gold"}', 'mos_anon_id=anon-77');
eq('anon identity when no JWT', m.identity.anonymousIdentifier, 'anon-77');
eq('anon identity carries no JWT', m.identity.userJwt, null);

m = merged('{}', '');
eq('mints when no cookies', m.identity.createAnonymousIdentifier, true);

m = merged('{"identity":{"userJwt":"forged"},"http":{"url":"evil"}}', 'mos_user_jwt=real.jwt.sig');
eq('client cannot forge identity', m.identity.userJwt, 'real.jwt.sig');
eq('client cannot forge http', m.http.url, 'https://site.test/wp-json/mos/checkout');

m = merged('', 'mos_user_jwt=real.jwt.sig');
eq('empty body still yields envelope', m.identity.userJwt, 'real.jwt.sig');
m = merged('[1,2,3]', 'mos_anon_id=a1');
eq('non-object body ignored, no abort', m.identity.anonymousIdentifier, 'a1');

m = merged('{"nested":{"a":[1,{"b":2}]},"s":"x"}', 'mos_anon_id=a1');
eq('nested client JSON survives', m.nested, { a: [1, { b: 2 }] });

setEnv({ MOS_JWT_COOKIE: 'wp_jwt' });
m = merged('{}', 'wp_jwt=custom.jwt.sig');
eq('custom JWT cookie name honoured', m.identity.userJwt, 'custom.jwt.sig');

setEnv({ MOS_ANON_FALLBACK: 'false' });
m = merged('{}', 'mos_user_jwt=a.b.c');
eq('fallback flag off when configured', m.identity.createAnonymousIdentifierFallback, false);

setEnv({ MOS_SECRET_KEY: 'pk_preview_abc123' });
m = merged('{"plan":"gold"}', 'mos_user_jwt=a.b.c');
eq('pk_ token omits http on authed routes', m.http, undefined);
eq('pk_ token still sends identity', m.identity.userJwt, 'a.b.c');
eq('pk_ token still merges client body', m.plan, 'gold');
setEnv();

console.log('\nsurfaceBehavior.http compilation');
const behavior = (http) => JSON.parse(call(ex.testCompileBehavior, JSON.stringify({ http })));

eq('absent http -> not present', JSON.parse(call(ex.testCompileBehavior, '{}')).present, false);
eq('empty http -> not present', behavior({}).present, false);

let b = behavior({ headers: { 'content-type': 'text/plain', 'x-a': '1' } });
eq('headers replaces whole set', [b.hrep, b.hset.length], [true, 2]);
eq('replacement headers carried', b.hset.find((h) => h.name === 'x-a').value, '1');

b = behavior({ cookies: ['a=1; Path=/', 'b=2'] });
eq('cookies resets then appends', [b.ckreset, b.ck], [true, ['a=1; Path=/', 'b=2']]);

b = behavior({ addHeaders: [{ name: 'x-paywall', value: 'hit' }] });
eq('addHeaders sets, no replace', [b.hrep, b.hset], [false, [{ name: 'x-paywall', value: 'hit' }]]);

b = behavior({ removeHeaders: ['etag', 'last-modified'] });
eq('removeHeaders collected', b.hdel, ['etag', 'last-modified']);

b = behavior({ addCookies: ['c=3'] });
eq('addCookies appends without reset', [b.ckreset, b.ck], [false, ['c=3']]);

b = behavior({ status: 402 });
eq('status override', b.st, 402);
eq('status 0 is falsy, ignored', behavior({ status: 0 }).st, 0);

b = behavior({ body: '<p>paywalled</p>' });
eq('body present -> returnImmediately', [b.hasBody, b.body], [true, '<p>paywalled</p>']);
b = behavior({ body: null });
eq('body null still returnImmediately', [b.hasBody, b.body], [true, '']);
eq('no body key -> not immediate', behavior({ status: 402 }).hasBody, false);

b = behavior({ status: 204, body: 'nope' });
eq('204 drops the body', [b.hasBody, b.body], [true, '']);
b = behavior({ status: 304, body: 'nope' });
eq('304 drops the body', b.body, '');
b = behavior({ status: 402, body: 'kept' });
eq('402 keeps the body', b.body, 'kept');

eq('statusAllowsBody matches upstream',
    [200, 204, 205, 304, 402, 199, 500].map((s) => ex.testStatusAllowsBody(s)),
    [1, 0, 0, 0, 1, 0, 1]);

// removeHeaders wins over addHeaders for the same name, as upstream (set then delete)
b = behavior({ addHeaders: [{ name: 'x-dup', value: 'v' }], removeHeaders: ['x-dup'] });
eq('remove ordered after set', [b.hset.length, b.hdel], [1, ['x-dup']]);

b = behavior({ headers: { 'x-base': 'b' }, addHeaders: [{ name: 'x-extra', value: 'e' }], status: 451, addCookies: ['z=9'] });
eq('combined set+modify', [b.hrep, b.hset.map((h) => h.name), b.st, b.ck], [true, ['x-base', 'x-extra'], 451, ['z=9']]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
