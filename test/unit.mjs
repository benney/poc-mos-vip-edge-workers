// Node harness: instantiates the compiled test.wasm, stubs the host imports, and
// asserts the shared modules (config, cookies, endpoints, behavior, identity, sampling).
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
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

console.log('\nported core version');
eq('the worker reports the version in package.json config', call(ex.testPortedCoreVersion), pkg.config.portedCoreVersion);
const divergencesPath = new URL('../DIVERGENCES.md', import.meta.url);
eq('DIVERGENCES.md names the same core version',
    existsSync(divergencesPath) && readFileSync(divergencesPath, 'utf8').includes(`\`@monetizationos/proxy\` ${pkg.config.portedCoreVersion}`), true);

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

console.log('\nWordPress feeds');
const feeds = ['/feed', '/feed/', '/feed/rss2/', '/comments/feed/', '/category/news/feed/atom/', '/my-post/feed/'];
const notFeeds = ['/', '/feedback/', '/feeding-time', '/feed/other/', '/2026/10/my-post/', '/news/feeds/'];
eq('feed paths', feeds.map((p) => callInt(ex.testIsFeed, p)), feeds.map(() => 1));
eq('not feeds', notFeeds.map((p) => callInt(ex.testIsFeed, p)), notFeeds.map(() => 0));

console.log('\ndecision sampling buckets');
const bucket = (id) => callInt(ex.testBucket, id);
const fnv1a = (s) => { let h = 0x811c9dc5; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0; return h % 100; };
eq('bucket is FNV-1a of the id, mod 100', ['anon-abc', 'j.w.t', 'x'].map(bucket), ['anon-abc', 'j.w.t', 'x'].map(fnv1a));
const buckets = Array.from({ length: 2000 }, (_, i) => bucket(`anon-${i}`));
eq('buckets are 0-99', buckets.every((b) => b >= 0 && b < 100), true);
const underHalf = buckets.filter((b) => b < 50).length;
eq('ids spread evenly (40-60% under 50)', underHalf > 800 && underHalf < 1200, true);

console.log('\nidentity (port of buildIdentity)');
const ident = (a, j) => JSON.parse(call(ex.testBuildIdentity, a, j));
// Only the keys that apply are sent, as core's Identity union has it.
eq('jwt wins over anon', ident('anon1', 'jwt1'), { userJwt: 'jwt1', createAnonymousIdentifierFallback: true });
eq('anon when no jwt', ident('anon1', ''), { anonymousIdentifier: 'anon1' });
eq('mint when neither', ident('', ''), { createAnonymousIdentifier: true });

// Core appends these after the configured routes.
const DEFAULT_ROUTES = ['offer-redemptions', 'access-checks', 'surface-decisions', 'counter-updates']
    .map((n) => `POST /mos-api/${n}>/api/v1/${n}`);
const routesWith = (...configured) => [...configured, ...DEFAULT_ROUTES].join('|');

console.log('\nidentity from the origin response (port of getExistingCookies)');
setEnv();
const decisionIdentity = (cookies, setCookies = []) => JSON.parse(call(ex.testIdentityForDecision, cookies, setCookies.join('\n')));
eq('request cookies when the origin sets neither', decisionIdentity('mos_anon_id=req-anon', ['wp_session=x; Path=/']), { anonymousIdentifier: 'req-anon' });
eq('origin jwt beats request cookies', decisionIdentity('mos_anon_id=req-anon', ['mos_user_jwt=origin.jwt; Path=/']),
    { userJwt: 'origin.jwt', createAnonymousIdentifierFallback: true });
eq('origin anon replaces the request anon', decisionIdentity('mos_anon_id=req-anon', ['mos_anon_id=origin-anon; Path=/']), { anonymousIdentifier: 'origin-anon' });
eq('either origin cookie hides the request jwt', decisionIdentity('mos_user_jwt=req.jwt', ['mos_anon_id=origin-anon']), { anonymousIdentifier: 'origin-anon' });
eq('an origin cookie with an empty value still counts as set', decisionIdentity('mos_anon_id=req-anon', ['mos_anon_id=; Max-Age=0']), { createAnonymousIdentifier: true });
eq('values are percent-decoded', decisionIdentity('mos_anon_id=a%20b'), { anonymousIdentifier: 'a b' });
eq('and so are origin values', decisionIdentity('', ['mos_user_jwt=x%2By; Path=/']), { userJwt: 'x+y', createAnonymousIdentifierFallback: true });

console.log('\nanonymous cookie (port of defaultPersistIdentity)');
setEnv();
const setsAnon = (cookies, setCookies, identifier, isAuthenticated) =>
    ex.testShouldSetAnonCookie(...[cookies, setCookies.join('\n'), identifier].flatMap(put), isAuthenticated ? 1 : 0) === 1;
eq('a minted id is set', setsAnon('', [], 'new-1', false), true);
eq('nothing without an identifier', setsAnon('', [], '', false), false);
eq('an existing anon cookie is not re-set', setsAnon('mos_anon_id=a1', [], 'a1', false), false);
eq('jwt fallback: unauthenticated, no anon cookie, set', setsAnon('mos_user_jwt=j.w.t', [], 'new-1', false), true);
eq('jwt fallback: authenticated, not set', setsAnon('mos_user_jwt=j.w.t', [], 'user-1', true), false);
eq('jwt fallback: unauthenticated but the request has an anon cookie, not set', setsAnon('mos_user_jwt=j.w.t; mos_anon_id=a1', [], 'new-1', false), false);
eq('jwt fallback: the origin jwt hides the request anon cookie, set', setsAnon('mos_anon_id=a1', ['mos_user_jwt=o.j.t; Path=/'], 'new-1', false), true);
eq('jwt fallback: the origin anon cookie counts, not set', setsAnon('mos_user_jwt=j.w.t', ['mos_anon_id=o1; Path=/'], 'o1', false), false);
setEnv({ MOS_ANON_FALLBACK: 'false' });
eq('jwt without the fallback flag: not set', setsAnon('mos_user_jwt=j.w.t', [], 'new-1', false), false);
setEnv();

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
eq('pk_ token omits http (D9)', cfgFields()[9], 'false');
setEnv();

setEnv({ MOS_ENVIRONMENT: 'live_override' });
eq('MOS_ENVIRONMENT overrides derivation (D17)', cfgFields()[2], 'live_override');
setEnv({ MOS_ENVIRONMENT: '' });
eq('empty override falls back to derivation', cfgFields()[2], 'live_ab12cd');

setEnv({ MOS_ANON_FALLBACK: 'false' });
eq('anon fallback opt-out', cfgFields()[6], 'false');

setEnv({ MOS_JWT_COOKIE: 'wp_jwt', MOS_ANON_COOKIE: 'wp_anon' });
f = cfgFields();
eq('cookie names overridable', [f[4], f[5]], ['wp_anon', 'wp_jwt']);

setEnv({ MOS_AUTHENTICATED_ROUTES: 'POST /wp-json/mos/checkout>/api/v1/checkout, put /wp-json/mos/profile>/api/v1/profile' });
eq('auth routes parsed, method upcased, defaults after', cfgFields()[7],
    routesWith('POST /wp-json/mos/checkout>/api/v1/checkout', 'PUT /wp-json/mos/profile>/api/v1/profile'));

setEnv({ MOS_AUTHENTICATED_ROUTES: 'GET /nope>/api/v1/nope, POST /ok>/api/v1/ok, garbage, POST /no-arrow, DELETE /d>/x, POST >/empty-match' });
eq('rejects GET/DELETE and malformed entries', cfgFields()[7], routesWith('POST /ok>/api/v1/ok'));

setEnv({ MOS_IGNORE_PREFIXES: '/wp-admin, /wp-login.php,', MOS_IGNORE_PATTERNS: '^/feed(/|$)   \\.amp$' });
f = cfgFields();
eq('ignore prefixes split on commas', f[8], '/wp-admin|/wp-login.php');
eq('ignore patterns split on spaces (D6)', f[10], '^/feed(/|$) \\.amp$');
setEnv({ MOS_AUTHENTICATED_ROUTES: 'POST />/api/v1/root' });
eq('root matchPath is valid', cfgFields()[7], routesWith('POST />/api/v1/root'));
setEnv({ MOS_SURFACE_DECISIONS_COOKIES: '^__session$   ^mos_' });
eq('decision cookie patterns split on spaces (D6)', cfgFields()[11], '^__session$ ^mos_');
setEnv();
eq('default routes with none configured', cfgFields()[7], routesWith());
eq('no decision cookies by default', cfgFields()[11], '');
eq('decisions percent defaults to 100 (D4)', cfgFields()[12], '100');
const percent = (v) => (setEnv({ MOS_DECISIONS_PERCENT: v }), cfgFields()[12]);
eq('decisions percent parsed and clamped', ['0', '25', ' 50 ', '100', '150', '-5', 'abc', '', '12.5', '99999999999'].map(percent),
    ['0', '25', '50', '100', '100', '0', '100', '100', '100', '100']);
setEnv();

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
eq('default route matches', route('/mos-api/access-checks', 'POST'), 'POST /api/v1/access-checks');
eq('default routes are POST only', route('/mos-api/access-checks', 'PUT'), '');
eq('all four defaults', ['offer-redemptions', 'access-checks', 'surface-decisions', 'counter-updates'].map((n) => route(`/mos-api/${n}`, 'POST')),
    ['offer-redemptions', 'access-checks', 'surface-decisions', 'counter-updates'].map((n) => `POST /api/v1/${n}`));
setEnv({ MOS_AUTHENTICATED_ROUTES: 'POST /mos-api/access-checks>/api/v1/custom' });
eq('a configured route wins over the default for the same path', route('/mos-api/access-checks', 'POST'), 'POST /api/v1/custom');
setEnv();

console.log('\nauthenticated route payload (JWT passthrough)');
setEnv();
const merged = (body, cookies, url = 'https://site.test/wp-json/mos/checkout') =>
    JSON.parse(call(ex.testMergeBody, body, cookies, url));

let m = merged('{"plan":"gold","qty":2}', 'mos_user_jwt=eyJhbG.payload.sig; other=1');
eq('sk_ key sends http on authed routes', m.http !== undefined, true);
eq('client body keys preserved', [m.plan, m.qty], ['gold', 2]);
eq('JWT forwarded from cookie', m.identity.userJwt, 'eyJhbG.payload.sig');
eq('JWT sets fallback flag', m.identity.createAnonymousIdentifierFallback, true);
eq('no anon id when JWT present', m.identity.anonymousIdentifier, undefined);
eq('http metadata attached', m.http.url, 'https://site.test/wp-json/mos/checkout');
eq('absent userAgent, clientIP and referer are left out', Object.keys(m.http), ['url']);

m = merged('{"plan":"gold"}', 'mos_anon_id=anon-77');
eq('anon identity when no JWT', m.identity.anonymousIdentifier, 'anon-77');
eq('anon identity carries no JWT', m.identity.userJwt, undefined);
eq('anon identity is just the identifier', m.identity, { anonymousIdentifier: 'anon-77' });

m = merged('{}', '');
eq('mints when no cookies', m.identity, { createAnonymousIdentifier: true });

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
eq('fallback flag off when configured: the key is left out', m.identity, { userJwt: 'a.b.c' });

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
