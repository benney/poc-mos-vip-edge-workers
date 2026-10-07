// End-to-end: real compiled whole-body worker + Node host + fake MOS API + fake WordPress
// origin. Everything happens in onClientRequest, so every page view is a short-circuit
// and the assertions are against the response the worker hands back.
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

/** Fake WordPress: HTML for pages, a redirect, and a gzip page it ignores identity for. */
function wordpress(state, { url, headers }) {
    state.originCalls.push({ url, headers });
    if (state.originFail) return { errorKind: 'timeout', errorMessage: 'origin slow' };
    const path = url.replace(SITE, '').replace('https://origin.site.test', '');
    if (path === '/old') return { status: 301, headers: [['location', '/story']], body: '' };
    if (path === '/feed') return { status: 200, headers: [['content-type', 'application/rss+xml']], body: '<rss/>' };
    if (path === '/gz') return { status: 200, headers: [['content-type', 'text/html'], ['content-encoding', 'gzip']], body: 'binary' };
    return {
        status: state.originStatus ?? 200,
        headers: [['content-type', 'text/html; charset=utf-8'], ['etag', 'W/"abc"'], ['set-cookie', 'wp_session=xyz; Path=/'], ['content-length', '999']],
        body: state.originHtml ?? ORIGIN_HTML,
    };
}

/** Fake MOS: echoes what firecrest does with http.proxyOrigin.body via state.respond. */
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

async function request(state, { method = 'GET', url = '/story', headers = [['host', 'site.test']], body = null } = {}) {
    const host = await new EdgeWorkerHost(WASM, {
        env: state.env ?? ENV,
        fetchHandler: async (call) => (call.url.startsWith('https://api.mos.test') ? mos(state, call) : wordpress(state, call)),
    }).init();
    return host.clientRequest({ method, url, headers, body });
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
    respond: () => decisions({ surfaceBehavior: { http: { body: PAYWALLED_HTML } } }),
    ...over,
});

section('page view: origin page goes to MOS, transformed page comes back');
{
    const state = fresh();
    const res = await request(state, { headers: [['host', 'site.test'], ['cookie', 'wordpress_logged_in=u1'], ['user-agent', 'UA'], ['accept-encoding', 'gzip, br']] });

    ok('short-circuited from the request phase', res.shortCircuited);
    eq('one origin fetch, then one MOS call', [state.originCalls.length, state.mosCalls.length], [1, 1]);
    eq('fetched its own host', state.originCalls[0].url, `${SITE}/story`);
    eq('forwarded the WordPress cookie', header(state.originCalls[0].headers, 'cookie'), ['wordpress_logged_in=u1']);
    eq('asked origin for an uncompressed page', header(state.originCalls[0].headers, 'accept-encoding'), ['identity']);
    eq('tagged its own fetch', header(state.originCalls[0].headers, 'x-mos-origin-fetch').map((v) => v.length), [64]);

    const sent = JSON.parse(state.mosCalls[0].body);
    eq('sent origin status and page', [sent.http.proxyOrigin.status, sent.http.proxyOrigin.body], [200, ORIGIN_HTML]);
    eq('and nothing else in proxyOrigin', Object.keys(sent.http.proxyOrigin).sort(), ['body', 'status']);
    eq('left resource.meta for MOS to read from the page', sent.resource, { id: '/story' });
    eq('identifies as the whole-body client', header(state.mosCalls[0].headers, 'x-mos-proxy-client'), ['vip-edge-worker-whole-body-poc']);

    eq('origin status', res.status, 200);
    eq('transformed page', res.body, PAYWALLED_HTML);
    eq('origin headers kept', [header(res.headers, 'content-type'), header(res.headers, 'etag')], [['text/html; charset=utf-8'], ['W/"abc"']]);
    eq('stale content-length dropped', header(res.headers, 'content-length'), []);
    eq('origin cookie then anon cookie', header(res.headers, 'set-cookie'), ['wp_session=xyz; Path=/', 'mos_anon_id=anon-wb-1; Path=/']);
    eq('not cacheable', header(res.headers, 'cache-control'), ['no-store']);
}

section('no transformed body: origin page served with the http ops');
{
    const state = fresh({ respond: () => decisions({ surfaceBehavior: { http: { addHeaders: [{ name: 'x-mos', value: '1' }], removeHeaders: ['etag'] } } }) });
    const res = await request(state);
    eq('origin page', res.body, ORIGIN_HTML);
    eq('header added and removed', [header(res.headers, 'x-mos'), header(res.headers, 'etag')], [['1'], []]);
}

section("workflow's own response replaces origin's");
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
    eq('MOS down: origin page, fetched once', [res.status, res.body, state.originCalls.length], [200, ORIGIN_HTML, 1]);

    const down = fresh({ originFail: true });
    const passed = await request(down);
    ok('origin fetch failed: passes through to VIP', !passed.shortCircuited);
    eq('no MOS call', down.mosCalls.length, 0);

    const unconfigured = fresh({ env: {} });
    ok('unconfigured: passes through', !(await request(unconfigured)).shortCircuited);
}

section('only uncompressed HTML goes to MOS');
{
    for (const [url, status] of [['/feed', 200], ['/old', 301], ['/gz', 200]]) {
        const state = fresh();
        const res = await request(state, { url });
        eq(`${url}: served as fetched, no MOS call`, [res.status, state.mosCalls.length], [status, 0]);
    }
    const asset = fresh();
    ok('asset path: passes through without fetching', !(await request(asset, { url: '/wp-content/style.css' })).shortCircuited && asset.originCalls.length === 0);
    const ignored = fresh();
    ok('ignored prefix: passes through', !(await request(ignored, { url: '/wp-admin/' })).shortCircuited && ignored.originCalls.length === 0);
    const post = fresh();
    ok('POST: passes through', !(await request(post, { method: 'POST', url: '/story' })).shortCircuited);
}

section('loop guard');
{
    const state = fresh();
    await request(state);
    const token = header(state.originCalls[0].headers, 'x-mos-origin-fetch')[0];

    const own = fresh();
    const reentry = await request(own, { headers: [['host', 'site.test'], ['x-mos-origin-fetch', token]] });
    ok('own fetch re-entering: passes through untouched', !reentry.shortCircuited && own.originCalls.length === 0 && own.mosCalls.length === 0);

    const forged = fresh();
    const res = await request(forged, { headers: [['host', 'site.test'], ['x-mos-origin-fetch', 'f'.repeat(64)]] });
    eq('forged header: still paywalled', res.body, PAYWALLED_HTML);
    ok('forged header not forwarded as-is', header(forged.originCalls[0].headers, 'x-mos-origin-fetch')[0] === token);
}

section('MOS_ORIGIN_URL points at the origin directly');
{
    const state = fresh({ env: { ...ENV, MOS_ORIGIN_URL: 'https://origin.site.test/' } });
    await request(state, { url: '/story?x=1' });
    eq('fetched the configured origin, query kept', state.originCalls[0].url, 'https://origin.site.test/story?x=1');
}

section('custom endpoints still route to MOS');
{
    const state = fresh();
    const res = await request(state, { url: '/mos-endpoints/hello' });
    eq('endpoint served, no origin fetch', [res.status, state.originCalls.length], [200, 0]);
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
