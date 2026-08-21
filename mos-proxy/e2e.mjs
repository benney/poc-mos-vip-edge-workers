// End-to-end: real compiled worker + Node host + fake MOS API + fake WordPress origin.
// Drives onClientRequest -> origin -> onOriginResponse and applies the resulting
// rules with real lol-html, so the assertions are against final wire output.
import { readFileSync } from 'node:fs';
import { EdgeWorkerHost } from '../devkit/host.mjs';
import { applyHtmlRules } from '../devkit/rewrite.mjs';

const WASM = readFileSync(new URL('../build/mos-proxy/release.wasm', import.meta.url));

const ENV = {
    MOS_HOST: 'https://api.mos.test',
    MOS_SURFACE_SLUG: 'news',
    MOS_SECRET_KEY: 'sk_live_ab12cd',
    MOS_INJECT_SCRIPT_URL: 'https://cdn.mos.test/mos.js',
    MOS_IGNORE_PREFIXES: '/wp-admin,/wp-login.php',
    MOS_AUTHENTICATED_ROUTES: 'POST /wp-json/mos/checkout>/api/v1/checkout',
};

const ORIGIN_HTML = `<!doctype html>
<html><head><title>Story</title><meta name="og:title" content="Story"></head>
<body>
<article class="article-body"><p id="lede">First para.</p><p>Second para.</p></article>
<div class="upsell">old upsell</div>
<footer>fin</footer>
</body></html>`;

// ---------- fakes ----------

const decisions = (over = {}) => ({
    status: 'success',
    identity: { identifier: 'anon-e2e-1', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: true },
    surfaceBehavior: {},
    componentsSkipped: false,
    componentBehaviors: {},
    ...over,
});

function makeMosApi(state) {
    return async ({ method, url, headers, body }) => {
        state.calls.push({ method, url, headers, body });
        const path = url.replace('https://api.mos.test', '');

        if (path === '/api/v1/surface-decisions') {
            if (state.decisionsFail) return { errorKind: 'timeout', errorMessage: 'upstream slow' };
            if (state.decisionsStatus && state.decisionsStatus !== 200) {
                return { status: state.decisionsStatus, headers: [['content-type', 'application/json']], body: JSON.stringify({ status: 'error', message: 'nope', statusCode: state.decisionsStatus }) };
            }
            return { status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(state.decisions) };
        }
        if (path.startsWith('/api/v1/envs/')) {
            return { status: 200, headers: [['content-type', 'application/json'], ['x-endpoint', 'hit']], body: JSON.stringify({ proxied: path, method, echo: body ? JSON.parse(body) : null }) };
        }
        if (path === '/api/v1/checkout') {
            return { status: 201, headers: [['content-type', 'application/json']], body: JSON.stringify({ ok: true, received: JSON.parse(body) }) };
        }
        return { status: 404, headers: [], body: '{}' };
    };
}

/** Fake WordPress: HTML for pages, non-HTML for assets. */
function origin(req) {
    if (req.url.endsWith('.css')) return { status: 200, headers: [['content-type', 'text/css']], body: 'body{}' };
    if (req.url.startsWith('/feed')) return { status: 200, headers: [['content-type', 'application/xml']], body: '<rss/>' };
    return { status: 200, headers: [['content-type', 'text/html; charset=utf-8'], ['etag', 'W/"abc"'], ['set-cookie', 'wp_session=xyz; Path=/']], body: ORIGIN_HTML };
}

/** One full request through both phases. */
async function request(state, { method = 'GET', url = '/story', headers = [], body = null } = {}) {
    const host = await new EdgeWorkerHost(WASM, {
        env: state.env ?? ENV,
        fetchHandler: makeMosApi(state),
    }).init();

    const phase1 = await host.clientRequest({ method, url, headers, body });
    if (phase1.shortCircuited) {
        return { shortCircuited: true, status: phase1.status, headers: phase1.headers, body: phase1.body, hitOrigin: false, mosCalls: state.calls };
    }

    const originReq = { method: phase1.method, url: phase1.url, headers: phase1.headers, body: phase1.body };
    const originRes = origin(originReq);

    const phase2 = await host.originResponse({
        status: originRes.status,
        headers: originRes.headers,
        snapshot: originReq,
    });

    const html = await applyHtmlRules(originRes.body, phase2.rules);
    return {
        shortCircuited: false,
        status: phase2.status,
        headers: phase2.headers,
        body: html,
        hitOrigin: true,
        originReq,
        rules: phase2.rules,
        mosCalls: state.calls,
    };
}

// ---------- assertions ----------

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
};
const ok = (name, cond) => eq(name, !!cond, true);
const section = (s) => console.log(`\n${s}`);

const fresh = (over = {}) => ({ calls: [], decisions: decisions(), ...over });

// ---------- scenario 1: component injection ----------

section('anonymous page view: components + script injection');
{
    const state = fresh();
    state.decisions = decisions({
        componentBehaviors: {
            paywall: {
                metadata: { cssSelector: '.article-body' },
                content: {
                    before: [{ type: 'html', content: '<aside id="promo">Subscribe</aside>' }],
                    append: [{ type: 'element', schema: 'mos:paywall@2', props: { tier: 'gold' } }],
                },
            },
            upsell: { metadata: { cssSelector: '.upsell' }, content: { remove: true } },
        },
    });
    const res = await request(state, { url: '/story' });

    ok('reached origin', res.hitOrigin);
    eq('one MOS call', res.mosCalls.length, 1);
    eq('called surface-decisions', res.mosCalls[0].url, 'https://api.mos.test/api/v1/surface-decisions');
    eq('POST with auth', [res.mosCalls[0].method, res.mosCalls[0].headers.find((h) => h[0] === 'authorization')[1]], ['POST', 'Bearer sk_live_ab12cd']);

    const sent = JSON.parse(res.mosCalls[0].body);
    eq('surface slug sent', sent.surfaceSlug, 'news');
    eq('resource id is path', sent.resource.id, '/story');
    eq('mints identity when no cookie', sent.identity.createAnonymousIdentifier, true);
    eq('origin status unknown at request time', sent.http.proxyOrigin.status, 0);

    ok('promo inserted before article', res.body.includes('<aside id="promo">Subscribe</aside><article'));
    ok('web component appended inside article', res.body.includes('<mos-paywall version="2" props="{&quot;tier&quot;:&quot;gold&quot;}"></mos-paywall></article>'));
    ok('upsell removed', !res.body.includes('old upsell'));
    ok('script injected into head', res.body.includes('<script src="https://cdn.mos.test/mos.js" async defer></script></head>'));
    ok('original content preserved', res.body.includes('First para.') && res.body.includes('fin'));

    eq('anon cookie set', res.headers.getAll('set-cookie'), ['wp_session=xyz; Path=/', 'mos_anon_id=anon-e2e-1; Path=/']);
    eq('personalised html not cached', res.headers.get('cache-control'), 'no-store');
    eq('status unchanged', res.status, 200);
    ok('plan header sent to origin', res.originReq.headers.get('x-mos-plan') !== null);
}

// ---------- scenario 2: paywall hard block ----------

section('surfaceBehavior with body: short-circuits before origin');
{
    const state = fresh();
    state.decisions = decisions({
        surfaceBehavior: {
            http: {
                status: 402,
                body: '<html><body><h1>Subscribe to continue</h1></body></html>',
                headers: { 'content-type': 'text/html', 'x-mos-paywall': 'blocked' },
                cookies: ['mos_wall=1; Path=/'],
            },
        },
        componentBehaviors: { ignored: { metadata: { cssSelector: '.article-body' }, content: { remove: true } } },
    });
    const res = await request(state, { url: '/premium' });

    ok('short-circuited', res.shortCircuited);
    ok('origin never contacted', !res.hitOrigin);
    eq('status from behavior', res.status, 402);
    eq('body replaced', res.body, '<html><body><h1>Subscribe to continue</h1></body></html>');
    eq('replacement headers applied', res.headers.get('x-mos-paywall'), 'blocked');
    eq('behavior cookies applied', res.headers.getAll('set-cookie'), ['mos_wall=1; Path=/']);
    ok('no origin html leaked', !res.body.includes('First para.'));
}

section('surfaceBehavior body with no-body status drops the body');
{
    const state = fresh();
    state.decisions = decisions({ surfaceBehavior: { http: { status: 304, body: 'ignored' } } });
    const res = await request(state, { url: '/cached' });
    eq('304 short-circuits', [res.shortCircuited, res.status], [true, 304]);
    eq('body dropped', res.body, null);
}

// ---------- scenario 3: header/status modify, applied after origin ----------

section('surfaceBehavior without body: applied on the origin response');
{
    const state = fresh();
    state.decisions = decisions({
        surfaceBehavior: {
            http: {
                status: 451,
                addHeaders: [{ name: 'x-mos-region', value: 'blocked' }],
                removeHeaders: ['etag'],
                addCookies: ['mos_geo=eu; Path=/'],
            },
        },
        componentBehaviors: { note: { metadata: { cssSelector: 'footer' }, content: { prepend: [{ type: 'text', content: 'Restricted <b>' }] } } },
    });
    const res = await request(state, { url: '/story' });

    ok('reached origin', res.hitOrigin);
    eq('status overridden', res.status, 451);
    eq('header added', res.headers.get('x-mos-region'), 'blocked');
    eq('header removed', res.headers.get('etag'), null);
    eq('cookies appended after anon id', res.headers.getAll('set-cookie'), ['wp_session=xyz; Path=/', 'mos_anon_id=anon-e2e-1; Path=/', 'mos_geo=eu; Path=/']);
    ok('html still rewritten', res.body.includes('<footer>Restricted &lt;b&gt;fin</footer>'));
}

section('surfaceBehavior headers replacement wipes origin headers');
{
    const state = fresh();
    state.decisions = decisions({ surfaceBehavior: { http: { headers: { 'content-type': 'text/html', 'x-only': 'this' } } } });
    const res = await request(state, { url: '/story' });
    eq('origin etag gone', res.headers.get('etag'), null);
    eq('replacement header present', res.headers.get('x-only'), 'this');
    // Matches the upstream proxy: the header set is rebuilt *after* the identity cookie
    // is appended, so a `headers` replacement drops the anon cookie too.
    eq('replacement drops anon cookie, as upstream', res.headers.getAll('set-cookie'), []);
    // cache-control/x-original-cache-control are added afterwards by setCacheControl,
    // since the script-injection rule still applies to this response.
    eq('no origin headers survive the replacement',
        res.headers.entries().filter(([n]) => !['content-type', 'x-only', 'cache-control', 'x-original-cache-control'].includes(n)), []);
    eq('setCacheControl writes both headers',
        [res.headers.get('cache-control'), res.headers.get('x-original-cache-control')], ['no-store', 'no-store']);
}

// ---------- scenario 4: custom endpoints ----------

section('custom endpoints');
{
    const state = fresh();
    const res = await request(state, {
        method: 'POST',
        url: '/mos-endpoints/subscribe?plan=gold',
        headers: [['content-type', 'application/json'], ['cookie', 'mos_user_jwt=a.b.c'], ['host', 'site.test']],
        body: '{"email":"x@y.z"}',
    });

    ok('short-circuited', res.shortCircuited);
    ok('origin never contacted', !res.hitOrigin);
    eq('exactly one MOS call', res.mosCalls.length, 1);
    eq('rewritten to envs/endpoints with query', res.mosCalls[0].url,
        'https://api.mos.test/api/v1/envs/live_ab12cd/endpoints/subscribe?plan=gold');
    eq('method forwarded', res.mosCalls[0].method, 'POST');
    eq('client body forwarded', res.mosCalls[0].body, '{"email":"x@y.z"}');
    eq('client cookie forwarded', res.mosCalls[0].headers.find((h) => h[0] === 'cookie')[1], 'mos_user_jwt=a.b.c');
    eq('host header stripped', res.mosCalls[0].headers.find((h) => h[0] === 'host'), undefined);
    eq('proxy version header added', res.mosCalls[0].headers.find((h) => h[0] === 'x-mos-proxy-version')[1], '1.5.1');
    eq('no secret key leaked to endpoint proxy', res.mosCalls[0].headers.find((h) => h[0] === 'authorization'), undefined);
    eq('status passed through', res.status, 200);
    eq('api response headers passed through', res.headers.get('x-endpoint'), 'hit');
    eq('api body passed through', JSON.parse(res.body).proxied, '/api/v1/envs/live_ab12cd/endpoints/subscribe?plan=gold');
    eq('api saw the client json body', JSON.parse(res.body).echo, { email: 'x@y.z' });
}

// ---------- scenario 5: authenticated routes / JWT ----------

section('authenticated API route with JWT');
{
    const state = fresh();
    const res = await request(state, {
        method: 'POST',
        url: '/wp-json/mos/checkout',
        headers: [['content-type', 'application/json'], ['cookie', 'mos_user_jwt=head.body.sig; other=1'], ['user-agent', 'Mozilla/5.0'], ['x-forwarded-for', '203.0.113.9, 10.0.0.1'], ['referer', 'https://site.test/story'], ['host', 'site.test']],
        body: '{"plan":"gold","qty":2}',
    });

    ok('short-circuited', res.shortCircuited);
    ok('origin never contacted', !res.hitOrigin);
    eq('called mapped mos path', res.mosCalls[0].url, 'https://api.mos.test/api/v1/checkout');
    eq('secret key used', res.mosCalls[0].headers.find((h) => h[0] === 'authorization')[1], 'Bearer sk_live_ab12cd');

    const sent = JSON.parse(res.mosCalls[0].body);
    eq('client body merged', [sent.plan, sent.qty], ['gold', 2]);
    eq('JWT passed through', sent.identity.userJwt, 'head.body.sig');
    eq('anon fallback flag set', sent.identity.createAnonymousIdentifierFallback, true);
    eq('client ip is first xff hop', sent.http.clientIP, '203.0.113.9');
    eq('user agent forwarded', sent.http.userAgent, 'Mozilla/5.0');
    eq('referer forwarded', sent.http.referer, 'https://site.test/story');
    eq('full url built from host', sent.http.url, 'https://site.test/wp-json/mos/checkout');
    eq('api status passed through', res.status, 201);
    eq('api body passed through', JSON.parse(res.body).received.plan, 'gold');
}

section('JWT identity on the decisions call');
{
    const state = fresh();
    const res = await request(state, { url: '/story', headers: [['cookie', 'mos_user_jwt=j.w.t; mos_anon_id=existing-1']] });
    const sent = JSON.parse(res.mosCalls[0].body);
    eq('JWT wins over anon id', [sent.identity.userJwt, sent.identity.anonymousIdentifier], ['j.w.t', null]);
}

section('existing anon cookie is not re-set');
{
    const state = fresh();
    state.decisions = decisions({ identity: { identifier: 'existing-1', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} } });
    const res = await request(state, { url: '/story', headers: [['cookie', 'mos_anon_id=existing-1']] });
    const sent = JSON.parse(res.mosCalls[0].body);
    eq('existing anon id sent', sent.identity.anonymousIdentifier, 'existing-1');
    // This port always re-sets the cookie; the upstream proxy only sets it on mint.
    eq('cookie re-set (known POC deviation)', res.headers.getAll('set-cookie').includes('mos_anon_id=existing-1; Path=/'), true);
}

// ---------- scenario 6: gating and fail-open ----------

section('gating');
{
    let state = fresh();
    let res = await request(state, { url: '/assets/app.css' });
    eq('static asset: no MOS call', state.calls.length, 0);
    ok('asset passes through untouched', res.body === 'body{}');

    state = fresh();
    await request(state, { url: '/wp-admin/edit.php' });
    eq('ignored prefix: no MOS call', state.calls.length, 0);

    state = fresh();
    await request(state, { method: 'POST', url: '/wp-comments-post.php' });
    eq('non-GET page: no MOS call', state.calls.length, 0);

    state = fresh();
    res = await request(state, { url: '/feed/rss' });
    eq('non-html origin response: no rules', res.rules.length, 0);
    ok('xml untouched', res.body === '<rss/>');
}

section('fail-open');
{
    let state = fresh({ decisionsFail: true });
    let res = await request(state, { url: '/story' });
    ok('origin html served unchanged on fetch error', res.body === ORIGIN_HTML);
    eq('no rules applied', res.rules.length, 0);
    eq('no anon cookie', res.headers.getAll('set-cookie'), ['wp_session=xyz; Path=/']);
    eq('status untouched', res.status, 200);

    state = fresh({ decisionsStatus: 500 });
    res = await request(state, { url: '/story' });
    ok('origin html served unchanged on api error', res.body === ORIGIN_HTML);

    state = fresh();
    state.decisions = decisions({ componentsSkipped: true });
    res = await request(state, { url: '/story' });
    ok('componentsSkipped still injects script', res.body.includes('cdn.mos.test/mos.js'));
    ok('componentsSkipped applies no component rules', !res.body.includes('mos-paywall'));

    state = fresh();
    state.env = { MOS_HOST: 'https://api.mos.test' }; // incomplete config
    res = await request(state, { url: '/story' });
    eq('unconfigured: no MOS call', state.calls.length, 0);
    ok('unconfigured: passthrough', res.body === ORIGIN_HTML);
}

section('plan header cannot be spoofed');
{
    const state = fresh({ decisionsFail: true });
    const res = await request(state, {
        url: '/story',
        headers: [['x-mos-plan', JSON.stringify({ a: 'evil', r: [{ o: 'ai', s: 'body', h: '<script>pwn()</script>' }] })]],
    });
    ok('injected plan stripped', !res.body.includes('pwn()'));
    eq('no cookie from injected plan', res.headers.getAll('set-cookie'), ['wp_session=xyz; Path=/']);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
