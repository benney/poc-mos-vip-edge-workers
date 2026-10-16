// End-to-end: real compiled whole-body worker + Node host + fake MOS API + fake WordPress
// origin. Pages come from the modelled edge cache or the origin, and the worker transforms
// them in onClientResponse, so assertions are against the response the reader gets.
import { readFileSync } from 'node:fs';
import { EdgeWorkerHost } from '../devkit/host.mjs';

const WASM = readFileSync(new URL('../build/mos-proxy-whole-body/release.wasm', import.meta.url));

const ENV = {
    MOS_HOST: 'https://api.mos.test',
    MOS_SURFACE_SLUG: 'news',
    MOS_SECRET_KEY: 'sk_live_ab12cd',
    MOS_INJECT_SCRIPT_URL: 'https://cdn.mos.test/mos.js',
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
    componentBehaviors: {},
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
        headers: [['content-type', 'text/html; charset=utf-8'], ['etag', 'W/"abc"'], ['set-cookie', 'wp_session=xyz; Path=/']],
        body: state.originHtml ?? ORIGIN_HTML,
    };
}

/** Fake MOS: echoes what MOS does with http.proxyOrigin.body via state.respond. */
function mos(state, { method, url, headers, body }) {
    state.mosCalls.push({ method, url, headers, body });
    const path = url.replace('https://api.mos.test', '');
    if (path === '/api/v1/surface-decisions') {
        if (state.mosFail) return { errorKind: 'timeout', errorMessage: 'upstream slow' };
        const request = JSON.parse(body);
        return { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(state.respond(request)) };
    }
    if (path.startsWith('/api/v1/envs/')) return { status: 200, headers: [['content-type', 'application/json']], body: '{"endpoint":true}' };
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
    return { shortCircuited: false, status: phase2.status, headers: phase2.headers, body: phase2.body, hitOrigin };
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
    eq('identifies as the whole-body client', header(state.mosCalls[0].headers, 'x-mos-proxy-client'), ['vip-edge-worker-whole-body-poc']);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
