// Scenario presets. Each is a complete playground input.

const ORIGIN_HTML = `<!doctype html>
<html>
<head>
  <title>The Long Read</title>
  <meta name="og:title" content="The Long Read">
</head>
<body>
  <article class="article-body">
    <p id="lede">The first paragraph is always free.</p>
    <p>The second paragraph is where it gets interesting.</p>
  </article>
  <div class="upsell">Generic house ad</div>
  <footer>© Example News</footer>
</body>
</html>`;

const ENV = {
    MOS_HOST: 'https://api.mos.test',
    MOS_SURFACE_SLUG: 'news',
    // Publishable shape: this page is a browser. Production mos-proxy runs server-side
    // and uses an sk_ key there (see e2e.mjs, which models the production shape).
    MOS_SECRET_KEY: 'pk_test_ab12cd',
    MOS_INJECT_SCRIPT_URL: 'https://cdn.mos.test/mos.js',
    MOS_IGNORE_PREFIXES: '/wp-admin,/wp-login.php',
    MOS_AUTHENTICATED_ROUTES: 'POST /wp-json/mos/checkout>/api/v1/checkout',
};

const decisions = (over = {}) => ({
    status: 'success',
    identity: { identifier: 'anon-7f3a', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
    features: {},
    customer: { hasProducts: true },
    surfaceBehavior: {},
    componentsSkipped: false,
    componentBehaviors: {},
    ...over,
});

const origin = (over = {}) => ({
    status: 200,
    headers: [
        ['content-type', 'text/html; charset=utf-8'],
        ['etag', 'W/"a1b2c3"'],
        ['set-cookie', 'wp_session=abc; Path=/'],
    ],
    body: ORIGIN_HTML,
    ...over,
});

const req = (over = {}) => ({
    method: 'GET',
    url: '/2026/the-long-read',
    headers: [['host', 'news.example.com'], ['user-agent', 'Mozilla/5.0'], ['x-forwarded-for', '203.0.113.9']],
    body: '',
    ...over,
});

export const PRESETS = {
    'Component injection': {
        note: 'Anonymous reader. Components inject a promo and a web component, remove the house ad, and the config script goes into <head>.',
        env: ENV,
        request: req(),
        origin: origin(),
        failDecisions: false,
        decisions: decisions({
            componentBehaviors: {
                paywall: {
                    metadata: { cssSelector: '.article-body' },
                    content: {
                        before: [{ type: 'html', content: '<aside class="promo">Subscribe for full access</aside>' }],
                        append: [{ type: 'element', schema: 'mos:paywall@2', props: { tier: 'gold', remaining: 0 } }],
                    },
                },
                houseAd: { metadata: { cssSelector: '.upsell' }, content: { remove: true } },
            },
        }),
    },

    'Paywall hard block': {
        note: 'surfaceBehavior.http carries a `body`, which means returnImmediately: the body replaces the cached page and components are skipped.',
        env: ENV,
        request: req({ url: '/2026/premium-scoop' }),
        origin: origin(),
        failDecisions: false,
        decisions: decisions({
            surfaceBehavior: {
                http: {
                    status: 402,
                    headers: { 'content-type': 'text/html; charset=utf-8', 'x-mos-paywall': 'blocked' },
                    cookies: ['mos_wall=1; Path=/'],
                    body: '<!doctype html><html><body><h1>Subscribe to continue reading</h1></body></html>',
                },
            },
        }),
    },

    'Header + status only': {
        note: 'surfaceBehavior.http with no `body`, so it applies to the page response: status override, header add/remove, extra cookie, and HTML rewriting still runs.',
        env: ENV,
        request: req(),
        origin: origin(),
        failDecisions: false,
        decisions: decisions({
            surfaceBehavior: {
                http: {
                    status: 451,
                    addHeaders: [{ name: 'x-mos-region', value: 'blocked' }],
                    removeHeaders: ['etag'],
                    addCookies: ['mos_geo=eu; Path=/'],
                },
            },
            componentBehaviors: {
                notice: {
                    metadata: { cssSelector: 'footer' },
                    content: { prepend: [{ type: 'text', content: 'Unavailable in your region. ' }] },
                },
            },
        }),
    },

    'Custom endpoint': {
        note: 'A /mos-endpoints/* request is rewritten to the MOS envs/endpoints path and short-circuited. Client method, body, and cookies are forwarded; the secret key is not.',
        env: ENV,
        request: req({
            method: 'POST',
            url: '/mos-endpoints/subscribe?plan=gold',
            headers: [['host', 'news.example.com'], ['content-type', 'application/json'], ['cookie', 'mos_user_jwt=head.body.sig']],
            body: '{"email":"reader@example.com"}',
        }),
        origin: origin(),
        failDecisions: false,
        decisions: decisions(),
    },

    'Authenticated route (JWT)': {
        note: 'A configured route merges the client JSON body with the resolved identity and http metadata, then calls MOS with the secret key. The JWT comes from the cookie.',
        env: ENV,
        request: req({
            method: 'POST',
            url: '/wp-json/mos/checkout',
            headers: [
                ['host', 'news.example.com'],
                ['content-type', 'application/json'],
                ['cookie', 'mos_user_jwt=head.body.sig; other=1'],
                ['user-agent', 'Mozilla/5.0'],
                ['x-forwarded-for', '203.0.113.9, 10.0.0.1'],
                ['referer', 'https://news.example.com/2026/the-long-read'],
            ],
            body: '{"plan":"gold","qty":2}',
        }),
        origin: origin(),
        failDecisions: false,
        decisions: decisions(),
    },

    'Fail open (API down)': {
        note: 'The decisions call fails, so the page is served as cached, untouched and with no cookie.',
        env: ENV,
        request: req(),
        origin: origin(),
        failDecisions: true,
        decisions: decisions(),
    },

    'Ignored path': {
        note: 'Path matches MOS_IGNORE_PREFIXES, so the worker makes no MOS call at all.',
        env: ENV,
        request: req({ url: '/wp-admin/edit.php' }),
        origin: origin(),
        failDecisions: false,
        decisions: decisions(),
    },
};
