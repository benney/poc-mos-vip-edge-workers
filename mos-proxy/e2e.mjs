// End-to-end: real compiled worker + Node host + fake MOS API + fake WordPress
// origin. Pages come from the modelled edge cache or the origin, and the worker transforms
// them in onClientResponse, so assertions are against the response the reader gets.
import { readFileSync } from 'node:fs';
import { EdgeWorkerHost } from '../devkit/host.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const WASM = readFileSync(new URL('../build/mos-proxy/release.wasm', import.meta.url));

const ENV = {
    MOS_HOST: 'https://api.mos.test',
    MOS_SURFACE_SLUG: 'news',
    MOS_SECRET_KEY: 'sk_live_ab12cd',
    MOS_IGNORE_PREFIXES: '/wp-admin,/wp-login.php',
    MOS_AUTHENTICATED_ROUTES: 'POST /wp-json/mos/checkout>/api/v1/checkout',
};

const SITE = 'https://site.test';

const ORIGIN_HTML = `<!doctype html>
<html><head><title>Story</title><meta name="category" content="sport"></head>
<body><article class="article-body"><p id="lede">Free para.</p><p>Paid para.</p></article></body></html>`;

const PAYWALLED_HTML = ORIGIN_HTML.replace('<p>Paid para.</p>', '<div class="paywall">Subscribe</div>');

const decisions = (over = {}) => ({
    status: 'success',
    identity: { identifier: 'anon-wb-1', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: true },
    surfaceBehavior: {},
    componentsSkipped: false,
    // Applied by MOS server-side; the worker must skip the unknown key.
    componentBehaviors: [{ metadata: { cssSelector: '.article-body' }, content: { append: [{ type: 'html', content: '<aside>Promo</aside>' }] } }],
    ...over,
});

/** Fake WordPress, reached by VIP on a cache miss: HTML pages, a redirect, a feed and a gzip page. */
function wordpress(state, { url, headers }) {
    state.originCalls.push({ url, headers });
    if (url === '/old') return { status: 301, headers: [['location', '/story']], body: '' };
    if (url === '/feed') return { status: 200, headers: [['content-type', 'application/rss+xml']], body: '<rss/>' };
    if (url === '/gz') return { status: 200, headers: [['content-type', 'text/html'], ['content-encoding', 'gzip']], body: 'binary' };
    if (url.endsWith('.css')) return { status: 200, headers: [['content-type', 'text/css']], body: 'body{}' };
    return {
        status: state.originStatus ?? 200,
        headers: [['content-type', 'text/html; charset=utf-8'], ['etag', 'W/"abc"'], ['set-cookie', 'wp_session=xyz; Path=/'], ...(state.originSetCookies ?? [])],
        body: state.originHtml ?? ORIGIN_HTML,
    };
}

/** Fake MOS: echoes what MOS does with http.proxyOrigin.body via state.respond. */
function mos(state, { method, url, headers, body }) {
    state.mosCalls.push({ method, url, headers, body });
    const path = url.replace('https://api.mos.test', '');
    if (path === '/api/v1/surface-decisions') {
        if (state.mosFail) return { errorKind: 'timeout', errorMessage: 'upstream slow' };
        if (state.decisionsStatus && state.decisionsStatus !== 200) {
            const error = { status: 'error', message: 'nope', statusCode: state.decisionsStatus };
            return { status: state.decisionsStatus, headers: [['content-type', 'application/json']], body: JSON.stringify(error) };
        }
        const request = JSON.parse(body);
        return { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(state.respond(request)) };
    }
    if (path.startsWith('/api/v1/envs/')) {
        const echo = { proxied: path, method, echo: body ? JSON.parse(body) : null };
        return { status: 200, headers: [['content-type', 'application/json'], ['x-endpoint', 'hit']], body: JSON.stringify(echo) };
    }
    if (path === '/api/v1/checkout') return { status: 201, headers: [['content-type', 'application/json']], body: JSON.stringify({ ok: true, received: JSON.parse(body) }) };
    if (path === '/api/v1/access-checks') return { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify({ ok: true, received: JSON.parse(body) }) };
    return { status: 404, headers: [], body: '{}' };
}

/**
 * One request: client request, then the edge cache (keyed by URL and Accept-Encoding, as
 * an origin sending Vary: Accept-Encoding would have it), WordPress on a miss, then the
 * client response. The worker's own fetches may only go to MOS.
 */
async function request(state, { method = 'GET', url = '/story', headers = [['host', 'site.test']], body = null } = {}) {
    const host = await new EdgeWorkerHost(WASM, {
        env: state.env ?? ENV,
        fetchHandler: async (call) => {
            if (call.url.startsWith('https://api.mos.test')) return mos(state, call);
            state.otherFetches.push(call.url);
            return { errorKind: 'transport', errorMessage: 'unexpected fetch' };
        },
    }).init();

    // The devkit hands back the input body when the worker's is empty; the output struct says
    // whether the worker emptied it on purpose.
    let output = null;
    const readOutputStruct = host.readOutputStruct.bind(host);
    host.readOutputStruct = (ptr) => (output = readOutputStruct(ptr));

    const phase1 = await host.clientRequest({ method, url, headers, body });
    if (phase1.shortCircuited) return { ...phase1, hitOrigin: false };

    const key = `${phase1.url}|${phase1.headers.get('accept-encoding') ?? ''}`;
    let stored = method === 'GET' ? state.cache.get(key) : undefined;
    const hitOrigin = stored === undefined;
    if (hitOrigin) {
        stored = wordpress(state, { url: phase1.url, headers: phase1.headers });
        if (method === 'GET') state.cache.set(key, stored);
    }

    const phase2 = await host.clientResponse({
        status: stored.status,
        headers: stored.headers,
        body: stored.body,
        snapshot: { method, url, headers },
    });
    const emptied = output.bodyLen === 0 && output.bodyPtr !== 0;
    return { shortCircuited: false, status: phase2.status, headers: phase2.headers, body: emptied ? '' : phase2.body, hitOrigin };
}

// Fetch calls carry header pairs; responses come back as the devkit's HeaderMap.
const header = (headers, name) =>
    Array.isArray(headers) ? headers.filter((h) => h[0].toLowerCase() === name).map((h) => h[1]) : headers.getAll(name);

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
};
const ok = (name, cond) => eq(name, !!cond, true);
const section = (s) => console.log(`\n${s}`);

const fresh = (over = {}) => ({
    originCalls: [],
    mosCalls: [],
    otherFetches: [],
    cache: new Map(),
    respond: () => decisions({ surfaceBehavior: { http: { body: PAYWALLED_HTML } } }),
    ...over,
});

section('page view: the served page goes to MOS, transformed page comes back');
{
    const state = fresh();
    const res = await request(state, { headers: [['host', 'site.test'], ['cookie', 'wordpress_logged_in=u1'], ['user-agent', 'UA'], ['accept-encoding', 'gzip, br']] });

    eq('VIP fetched the origin once, then one MOS call', [state.originCalls.length, state.mosCalls.length], [1, 1]);
    eq('the worker fetched nothing but MOS', state.otherFetches, []);
    eq('WordPress cookie reached the origin', header(state.originCalls[0].headers, 'cookie'), ['wordpress_logged_in=u1']);
    eq('asked origin for an uncompressed page', header(state.originCalls[0].headers, 'accept-encoding'), ['identity']);

    const sent = JSON.parse(state.mosCalls[0].body);
    eq('sent origin status and page', [sent.http.proxyOrigin.status, sent.http.proxyOrigin.body], [200, ORIGIN_HTML]);
    eq('and nothing else in proxyOrigin', Object.keys(sent.http.proxyOrigin).sort(), ['body', 'status']);
    eq('left resource.meta for MOS to read from the page', sent.resource, { id: '/story' });
    eq('identifies as the whole-body client (D11)', header(state.mosCalls[0].headers, 'x-mos-proxy-client'), ['vip-edge-worker-whole-body-poc']);

    eq('origin status', res.status, 200);
    eq('transformed page', res.body, PAYWALLED_HTML);
    eq('origin headers kept', [header(res.headers, 'content-type'), header(res.headers, 'etag')], [['text/html; charset=utf-8'], ['W/"abc"']]);
    eq('origin cookie then anon cookie', header(res.headers, 'set-cookie'), ['wp_session=xyz; Path=/', 'mos_anon_id=anon-wb-1; Path=/']);
    eq('reader copy is private', header(res.headers, 'cache-control'), ['private, no-store']);
}

section('cache: origin rendered once, every reader gets their own page');
{
    const state = fresh({ respond: (r) => decisions({ surfaceBehavior: { http: { body: r.http.proxyOrigin.body.replace('Free para.', `Hello ${r.identity.anonymousIdentifier}`) } } }) });
    const a = await request(state, { headers: [['host', 'site.test'], ['cookie', 'mos_anon_id=reader-a']] });
    const b = await request(state, { headers: [['host', 'site.test'], ['cookie', 'mos_anon_id=reader-b'], ['accept-encoding', 'br']] });

    eq('origin rendered once', state.originCalls.length, 1);
    eq('second reader served from cache', [a.hitOrigin, b.hitOrigin], [true, false]);
    eq('MOS saw the raw page both times', state.mosCalls.map((c) => JSON.parse(c.body).http.proxyOrigin.body), [ORIGIN_HTML, ORIGIN_HTML]);
    ok('each reader personalised', a.body.includes('Hello reader-a') && b.body.includes('Hello reader-b') && !b.body.includes('reader-a'));
    eq('cached copy is the origin page', [...state.cache.values()].map((r) => r.body), [ORIGIN_HTML]);
}

section('cookies forwarded to decisions, as upstream surfaceDecisionsCookies');
{
    let state = fresh();
    await request(state, { headers: [['host', 'site.test'], ['cookie', 'theme=dark']] });
    eq('none unless configured', JSON.parse(state.mosCalls[0].body).http.cookies, undefined);

    state = fresh({ env: { ...ENV, MOS_SURFACE_DECISIONS_COOKIES: '^wp_ ^theme$' } });
    await request(state, { headers: [['host', 'site.test'], ['cookie', 'theme=dark; wp_session=from-reader']] });
    eq('matching cookies, origin wins', JSON.parse(state.mosCalls[0].body).http.cookies, { theme: 'dark', wp_session: 'xyz' });
}

section('MOS_DECISIONS_PERCENT: readers outside it get the page without a MOS call');
{
    const state = fresh({ env: { ...ENV, MOS_DECISIONS_PERCENT: '0' } });
    const res = await request(state);
    eq('no MOS call', state.mosCalls.length, 0);
    eq('the page as served', [res.body, header(res.headers, 'cache-control')], [ORIGIN_HTML, []]);

    const half = fresh({ env: { ...ENV, MOS_DECISIONS_PERCENT: '50' } });
    const first = await request(half);
    ok('50%: a new reader gets a bucket token', header(first.headers, 'set-cookie').some((c) => /^mos_bucket=[0-9a-f]{16};/.test(c)));
}

section('no transformed body: page served with the http ops');
{
    const state = fresh({ respond: () => decisions({ surfaceBehavior: { http: { addHeaders: [{ name: 'x-mos', value: '1' }], removeHeaders: ['etag'] } } }) });
    const res = await request(state);
    eq('origin page', res.body, ORIGIN_HTML);
    eq('header added and removed', [header(res.headers, 'x-mos'), header(res.headers, 'etag')], [['1'], []]);
}

section("workflow's own response replaces the page");
{
    const state = fresh({
        respond: () => decisions({ surfaceBehavior: { http: { status: 402, headers: { 'content-type': 'text/plain' }, cookies: ['paywall=1'], body: 'Payment required' } } }),
    });
    const res = await request(state);
    eq('status', res.status, 402);
    eq('body', res.body, 'Payment required');
    eq('headers replaced', header(res.headers, 'content-type'), ['text/plain']);
    eq('cookies replaced, anon included', header(res.headers, 'set-cookie'), ['paywall=1']);
}

section('origin 404 still gets a decision, status preserved');
{
    const state = fresh({ originStatus: 404 });
    const res = await request(state);
    eq('sent 404 to MOS', JSON.parse(state.mosCalls[0].body).http.proxyOrigin.status, 404);
    eq('served 404 with the transformed page', [res.status, res.body], [404, PAYWALLED_HTML]);
}

section('fail open');
{
    const state = fresh({ mosFail: true });
    const res = await request(state);
    eq('MOS down: the page as served', [res.status, res.body, header(res.headers, 'set-cookie')], [200, ORIGIN_HTML, ['wp_session=xyz; Path=/']]);

    const unconfigured = fresh({ env: {} });
    const passed = await request(unconfigured);
    eq('unconfigured: no MOS call, page untouched', [unconfigured.mosCalls.length, passed.body], [0, ORIGIN_HTML]);
}

section('only uncompressed HTML pages go to MOS');
{
    for (const [url, status, body] of [['/feed', 200, '<rss/>'], ['/old', 301, ''], ['/gz', 200, 'binary'], ['/wp-content/style.css', 200, 'body{}'], ['/wp-admin/', 200, ORIGIN_HTML]]) {
        const state = fresh();
        const res = await request(state, { url });
        eq(`${url}: served as is, no MOS call`, [res.status, res.body, state.mosCalls.length], [status, body, 0]);
    }
    const post = fresh();
    await request(post, { method: 'POST', url: '/story' });
    eq('POST answered with HTML: decided, as upstream', post.mosCalls.length, 1);
    // Not reader pages, so no decision, and their compression is left alone. No ignore lists configured.
    for (const url of ['/wp-admin/edit.php', '/wp-login.php', '/wp-json/wp/v2/posts', '/xmlrpc.php', '/wp-cron.php', '/wp-includes/js/x', '/wp-content/uploads/2026/x', '/feed/', '/category/news/feed/']) {
        const s = fresh({ env: { ...ENV, MOS_IGNORE_PREFIXES: '' } });
        await request(s, { url, headers: [['host', 'site.test'], ['accept-encoding', 'br']] });
        eq(`WordPress path ${url}: no MOS call, accept-encoding kept`, [s.mosCalls.length, header(s.originCalls[0].headers, 'accept-encoding')], [0, ['br']]);
    }
    const asset = fresh();
    await request(asset, { url: '/wp-content/style.css', headers: [['host', 'site.test'], ['accept-encoding', 'br']] });
    eq('asset keeps its accept-encoding', header(asset.originCalls[0].headers, 'accept-encoding'), ['br']);
}

section('custom endpoints still route to MOS');
{
    const state = fresh();
    const res = await request(state, { url: '/mos-endpoints/hello' });
    eq('endpoint served from the request phase, no origin', [res.shortCircuited, res.status, state.originCalls.length], [true, 200, 0]);
}

section('a large page');
{
    const big = ORIGIN_HTML.replace('<p>Paid para.</p>', `<p>Paid para.</p>${'<p>Lorem ipsum dolor sit amet, "quoted" & escaped \\ text.</p>\n'.repeat(30000)}`);
    const state = fresh({ originHtml: big, respond: (r) => decisions({ surfaceBehavior: { http: { body: r.http.proxyOrigin.body.replace('Free para.', 'FREE') } } }) });
    const started = performance.now();
    const res = await request(state);
    const ms = performance.now() - started;
    ok(`${(big.length / 1024 / 1024).toFixed(1)} MB page round-trips intact`, res.body === big.replace('Free para.', 'FREE'));
    console.log(`       ${ms.toFixed(0)} ms in the local host (encode, MOS JSON parse, decode)`);
}

const sentBody = (call) => JSON.parse(call.body);
const setCookieNames = (res) => header(res.headers, 'set-cookie').map((c) => c.split('=')[0]);
const mosDecision = (id) => ({ identifier: id, isAuthenticated: false, authType: 'anonymous', jwtClaims: {} });

section('decisions call: URL, method, auth, slug, resource, mint');
{
    const state = fresh();
    await request(state);
    const call = state.mosCalls[0];
    eq('surface-decisions URL', call.url, 'https://api.mos.test/api/v1/surface-decisions');
    eq('POST with the secret key as Bearer', [call.method, header(call.headers, 'authorization')], ['POST', ['Bearer sk_live_ab12cd']]);
    const sent = sentBody(call);
    eq('surface slug', sent.surfaceSlug, 'news');
    eq('resource id is the path', sent.resource.id, '/story');
    eq('mints an identity when there is no cookie, with no other identity keys', sent.identity, { createAnonymousIdentifier: true });
    eq('absent userAgent, clientIP and referer are left out', Object.keys(sent.http).sort(), ['proxyOrigin', 'url']);
    eq('http.url is built from the host', sent.http.url, 'https://site.test/story');
    eq('reports the ported core version', header(call.headers, 'x-mos-proxy-version'), [pkg.config.portedCoreVersion]);
}

section('surfaceBehavior status 304 override drops the body');
{
    const state = fresh({ respond: () => decisions({ surfaceBehavior: { http: { status: 304, body: 'ignored' } } }) });
    const res = await request(state);
    eq('304 applied, body dropped', [res.status, res.body], [304, '']);
}

section('surfaceBehavior ops: cookie order, headers, status');
{
    const state = fresh({
        respond: () => decisions({
            surfaceBehavior: { http: { status: 451, addHeaders: [{ name: 'x-mos-region', value: 'blocked' }], removeHeaders: ['etag'], addCookies: ['mos_geo=eu; Path=/'] } },
        }),
    });
    const res = await request(state);
    eq('status overridden', res.status, 451);
    eq('header added, etag removed', [header(res.headers, 'x-mos-region'), header(res.headers, 'etag')], [['blocked'], []]);
    eq('origin cookie, then anon, then addCookies', header(res.headers, 'set-cookie'), ['wp_session=xyz; Path=/', 'mos_anon_id=anon-wb-1; Path=/', 'mos_geo=eu; Path=/']);
    eq('page untouched without a body', res.body, ORIGIN_HTML);
}

section('surfaceBehavior headers replacement wipes origin headers');
{
    const state = fresh({ respond: () => decisions({ surfaceBehavior: { http: { headers: { 'content-type': 'text/html', 'x-only': 'this' } } } }) });
    const res = await request(state);
    eq('origin etag gone', header(res.headers, 'etag'), []);
    eq('replacement header present', header(res.headers, 'x-only'), ['this']);
    // The set is rebuilt after the identity cookie is appended, as in the core stage order.
    eq('replacement drops the anon cookie', header(res.headers, 'set-cookie'), []);
    eq('no origin headers survive the replacement',
        res.headers.entries().filter(([n]) => !['content-type', 'x-only', 'cache-control'].includes(n)), []);
    eq('cache-control is set after the replacement', header(res.headers, 'cache-control'), ['private, no-store']);
}

section('custom endpoints: full request and response');
{
    const state = fresh();
    const res = await request(state, {
        method: 'POST',
        url: '/mos-endpoints/subscribe?plan=gold',
        headers: [['content-type', 'application/json'], ['cookie', 'mos_user_jwt=a.b.c'], ['host', 'site.test']],
        body: '{"email":"x@y.z"}',
    });
    const call = state.mosCalls[0];

    ok('short-circuited', res.shortCircuited);
    eq('origin never contacted', state.originCalls.length, 0);
    eq('exactly one MOS call', state.mosCalls.length, 1);
    eq('rewritten to envs/endpoints with query', call.url, 'https://api.mos.test/api/v1/envs/live_ab12cd/endpoints/subscribe?plan=gold');
    eq('method forwarded', call.method, 'POST');
    eq('client body forwarded', call.body, '{"email":"x@y.z"}');
    eq('client cookie forwarded', header(call.headers, 'cookie'), ['mos_user_jwt=a.b.c']);
    eq('host header stripped', header(call.headers, 'host'), []);
    eq('no authorization header is added', header(call.headers, 'authorization'), []);
    eq('x-mos-key carries the key as PublicBearer', header(call.headers, 'x-mos-key'), ['PublicBearer sk_live_ab12cd']);
    eq('reports the ported core version', header(call.headers, 'x-mos-proxy-version'), [pkg.config.portedCoreVersion]);
    eq('status passed through', res.status, 200);
    eq('api response headers passed through', header(res.headers, 'x-endpoint'), ['hit']);
    eq('api body passed through', JSON.parse(res.body).proxied, '/api/v1/envs/live_ab12cd/endpoints/subscribe?plan=gold');
    eq('api saw the client json body', JSON.parse(res.body).echo, { email: 'x@y.z' });
}

section('authenticated route with JWT');
{
    const state = fresh();
    const res = await request(state, {
        method: 'POST',
        url: '/wp-json/mos/checkout',
        headers: [['content-type', 'application/json'], ['cookie', 'mos_user_jwt=head.body.sig; other=1'], ['user-agent', 'Mozilla/5.0'], ['x-forwarded-for', '203.0.113.9, 10.0.0.1'], ['referer', 'https://site.test/story'], ['host', 'site.test']],
        body: '{"plan":"gold","qty":2}',
    });
    const call = state.mosCalls[0];

    ok('short-circuited', res.shortCircuited);
    eq('origin never contacted', state.originCalls.length, 0);
    eq('called the mapped MOS path', call.url, 'https://api.mos.test/api/v1/checkout');
    eq('secret key sent as PublicBearer', header(call.headers, 'authorization'), ['PublicBearer sk_live_ab12cd']);
    eq('reports the ported core version', header(call.headers, 'x-mos-proxy-version'), [pkg.config.portedCoreVersion]);

    const sent = sentBody(call);
    eq('client body merged', [sent.plan, sent.qty], ['gold', 2]);
    eq('JWT passed through', sent.identity.userJwt, 'head.body.sig');
    eq('JWT identity carries the fallback flag and nothing else', sent.identity, { userJwt: 'head.body.sig', createAnonymousIdentifierFallback: true });
    eq('client ip is the first xff hop (D10)', sent.http.clientIP, '203.0.113.9');
    eq('user agent forwarded', sent.http.userAgent, 'Mozilla/5.0');
    eq('referer forwarded', sent.http.referer, 'https://site.test/story');
    eq('full url built from host', sent.http.url, 'https://site.test/wp-json/mos/checkout');
    eq('api status passed through', res.status, 201);
    eq('api body passed through', JSON.parse(res.body).received.plan, 'gold');
}

section('JWT identity on the decisions call');
{
    const state = fresh();
    await request(state, { headers: [['host', 'site.test'], ['cookie', 'mos_user_jwt=j.w.t; mos_anon_id=existing-1']] });
    const sent = sentBody(state.mosCalls[0]);
    eq('JWT wins over anon id', [sent.identity.userJwt, sent.identity.anonymousIdentifier ?? null], ['j.w.t', null]);
}

section('existing anon cookie');
{
    const state = fresh({ respond: () => decisions({ identity: mosDecision('existing-1') }) });
    const res = await request(state, { headers: [['host', 'site.test'], ['cookie', 'mos_anon_id=existing-1']] });
    eq('existing anon id sent', sentBody(state.mosCalls[0]).identity.anonymousIdentifier, 'existing-1');
    // The port re-sets it on every decision that returns an identifier; core only on a mint (D3).
    eq('cookie re-set (D3)', header(res.headers, 'set-cookie').includes('mos_anon_id=existing-1; Path=/'), true);
}

section('cookies forwarded to decisions are decoded');
{
    const state = fresh({ env: { ...ENV, MOS_SURFACE_DECISIONS_COOKIES: '^wp_ ^theme$' } });
    await request(state, { headers: [['host', 'site.test'], ['cookie', 'theme=dark%20blue; wp_session=from-reader; other=1; mos_anon_id=a1']] });
    eq('matching cookies, decoded, origin wins', sentBody(state.mosCalls[0]).http.cookies, { theme: 'dark blue', wp_session: 'xyz' });
}

section('MOS_DECISIONS_PERCENT: sticky per reader through the bucket cookie (D4)');
{
    const env = { ...ENV, MOS_DECISIONS_PERCENT: '50' };
    const bucketCookie = (res) => header(res.headers, 'set-cookie').find((c) => c.startsWith('mos_bucket='));

    const called = async (token) => {
        const s = fresh({ env });
        const r = await request(s, { headers: [['host', 'site.test'], ['cookie', `mos_bucket=${token}`]] });
        return [s.mosCalls.length === 1, bucketCookie(r) === undefined];
    };
    const tokens = Array.from({ length: 40 }, (_, i) => `token-${i}`);
    const first = await Promise.all(tokens.map(called));
    const again = await Promise.all(tokens.map(called));
    eq('a reader with a token keeps it and gets the same answer every time', again, first);
    ok('no new token for a reader who has one', first.every(([, kept]) => kept));
    ok('some readers in, some out', first.some(([inSample]) => inSample) && first.some(([inSample]) => !inSample));

    // A new reader who lands in the rollout: the token is not an origin cookie and outlives a cookie reset.
    let inSample;
    for (let i = 0; i < 30 && !inSample; i++) {
        const s = fresh({ env: { ...env, MOS_SURFACE_DECISIONS_COOKIES: '^mos_' }, respond: () => decisions({ surfaceBehavior: { http: { cookies: ['reset=1'] } } }) });
        const r = await request(s);
        if (s.mosCalls.length === 1) inSample = { s, r };
    }
    ok('a new reader landed in the rollout', inSample);
    eq('the token is not forwarded as an origin cookie', sentBody(inSample.s.mosCalls[0]).http.cookies, undefined);
    eq('and survives a cookie reset', setCookieNames(inSample.r), ['reset', 'mos_bucket']);
}

section('ignore patterns are regexes, anchored by the pattern');
{
    const state = fresh({ env: { ...ENV, MOS_IGNORE_PATTERNS: '^/tag/ \\.amp$' } });
    await request(state, { url: '/tag/news' });
    await request(state, { url: '/story.amp' });
    eq('matching paths: no MOS call', state.mosCalls.length, 0);
    await request(state, { url: '/tagged-story' });
    eq('/tagged-story is not matched by ^/tag/, so it is decided', state.mosCalls.length, 1);
}

section('gating by response, not by path guess');
{
    let state = fresh();
    await request(state, { url: '/story.json' });
    eq('HTML at an asset-looking path is decided (the path guess only picks accept-encoding, D7)', state.mosCalls.length, 1);

    state = fresh();
    const res = await request(state, { url: '/assets/app.css' });
    eq('static asset: no MOS call, untouched', [state.mosCalls.length, res.body], [0, 'body{}']);
}

section('fail open on a MOS API error');
{
    for (const decisionsStatus of [500, 403]) {
        const state = fresh({ decisionsStatus });
        const res = await request(state);
        eq(`API ${decisionsStatus}: the page as served`, [res.status, res.body, header(res.headers, 'set-cookie'), header(res.headers, 'cache-control')], [200, ORIGIN_HTML, ['wp_session=xyz; Path=/'], []]);
    }
}

section('partial env passes through');
{
    const state = fresh({ env: { MOS_HOST: 'https://api.mos.test' } });
    const res = await request(state);
    eq('incomplete config: no MOS call, page untouched', [state.mosCalls.length, res.body], [0, ORIGIN_HTML]);
    const endpoint = await request(state, { url: '/mos-endpoints/hello' });
    eq('and custom endpoints are not routed', [endpoint.shortCircuited, state.mosCalls.length], [false, 0]);
}

section('custom endpoints: request context header');
{
    const state = fresh();
    await request(state, { url: '/mos-endpoints/hello', headers: [['host', 'site.test'], ['cookie', 'mos_user_jwt=a.b.c; mos_anon_id=ignored']] });
    eq('identity from the request cookies, empty client metadata',
        header(state.mosCalls[0].headers, 'x-mos-endpoint-request-context'), ['{"identity":{"userJwt":"a.b.c","createAnonymousIdentifierFallback":true},"clientMetadata":{}}']);

    const minted = fresh();
    await request(minted, { url: '/mos-endpoints/hello' });
    eq('a reader with no cookies mints',
        header(minted.mosCalls[0].headers, 'x-mos-endpoint-request-context'), ['{"identity":{"createAnonymousIdentifier":true},"clientMetadata":{}}']);

    const forged = fresh();
    await request(forged, {
        url: '/mos-endpoints/hello',
        headers: [['host', 'site.test'], ['x-mos-key', 'PublicBearer forged'], ['x-mos-endpoint-request-context', '{"identity":{"userJwt":"forged"}}'], ['x-mos-proxy-version', '9.9.9']],
    });
    const headers = forged.mosCalls[0].headers;
    eq('client copies of the key and context header are overwritten', [header(headers, 'x-mos-key'), header(headers, 'x-mos-endpoint-request-context')],
        [['PublicBearer sk_live_ab12cd'], ['{"identity":{"createAnonymousIdentifier":true},"clientMetadata":{}}']]);
    eq('so is the version header', header(headers, 'x-mos-proxy-version'), [pkg.config.portedCoreVersion]);
}

section('default authenticated routes');
{
    const state = fresh();
    const res = await request(state, {
        method: 'POST',
        url: '/mos-api/access-checks',
        headers: [['content-type', 'application/json'], ['host', 'site.test']],
        body: '{"resourceId":"r1"}',
    });
    const call = state.mosCalls[0];
    eq('POST /mos-api/access-checks reaches /api/v1/access-checks', [res.shortCircuited, call.url], [true, 'https://api.mos.test/api/v1/access-checks']);
    eq('with PublicBearer and the secret key', header(call.headers, 'authorization'), ['PublicBearer sk_live_ab12cd']);
    eq('client body and minted identity merged', [sentBody(call).resourceId, sentBody(call).identity], ['r1', { createAnonymousIdentifier: true }]);

    const get = fresh();
    const page = await request(get, { url: '/mos-api/access-checks' });
    eq('a GET is not a route: it goes to the origin as a page', [page.shortCircuited, get.originCalls.length], [false, 1]);
}

section('identity from the origin Set-Cookie');
{
    const state = fresh({ originSetCookies: [['set-cookie', 'mos_user_jwt=origin.jwt; Path=/']] });
    await request(state, { headers: [['host', 'site.test'], ['cookie', 'mos_anon_id=req-anon; mos_user_jwt=req.jwt']] });
    eq('the origin jwt is the identity, the request cookies are ignored',
        sentBody(state.mosCalls[0]).identity, { userJwt: 'origin.jwt', createAnonymousIdentifierFallback: true });

    const custom = fresh({ originSetCookies: [['set-cookie', 'mos_user_jwt=origin.jwt; Path=/']] });
    await request(custom, { url: '/mos-endpoints/hello', headers: [['host', 'site.test'], ['cookie', 'mos_anon_id=req-anon']] });
    eq('custom endpoints use the request cookies only',
        header(custom.mosCalls[0].headers, 'x-mos-endpoint-request-context'), ['{"identity":{"anonymousIdentifier":"req-anon"},"clientMetadata":{}}']);
}

section('no-body statuses');
{
    const state = fresh({ respond: () => decisions({ surfaceBehavior: { http: { status: 204 } } }) });
    const res = await request(state);
    eq('a 204 override gives an empty body, even with no body key', [res.status, res.body], [204, '']);

    const kept = fresh({ respond: () => decisions({ surfaceBehavior: { http: { status: 402 } } }) });
    const paid = await request(kept);
    eq('a 402 override keeps the page', [paid.status, paid.body], [402, ORIGIN_HTML]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
