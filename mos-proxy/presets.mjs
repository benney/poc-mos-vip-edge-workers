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
    // A fake sk_ shape: the worker only sends the page (`http`) for secret keys. Nothing
    // leaves the browser in fake mode. Not sk_(live|test|prod), so the UI does not warn.
    MOS_SECRET_KEY: 'sk_demo_ab12cd',
    MOS_IGNORE_PREFIXES: '/wp-admin,/wp-login.php',
    MOS_AUTHENTICATED_ROUTES: 'POST /wp-json/mos/checkout>/api/v1/checkout',
};

// What MOS would return for ORIGIN_HTML: the paywall block and promo already applied.
const WALLED_HTML = ORIGIN_HTML
    .replace('<p>The second paragraph is where it gets interesting.</p>',
        '<div class="paywall">Subscribe to keep reading</div>')
    .replace('<div class="upsell">Generic house ad</div>',
        '<aside class="promo">Subscribe for full access</aside>');

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
    'Whole-body paywall': {
        note: 'Anonymous reader. The worker sends the page to MOS (http.proxyOrigin) and serves the body that comes back in surfaceBehavior.http.body: a paywall block and a promo, applied by MOS.',
        env: ENV,
        request: req(),
        origin: origin(),
        failDecisions: false,
        decisions: decisions({
            surfaceBehavior: { http: { body: WALLED_HTML } },
        }),
    },

    'Workflow response (402)': {
        note: 'A workflow answers for the page: surfaceBehavior.http carries its own status, headers, cookies and body, which replace the page as served.',
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
        note: 'surfaceBehavior.http with no `body`: the page is served as fetched, with the status overridden, a header added, the etag removed and an extra cookie.',
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
        }),
    },

    'Compressed page': {
        note: 'The origin page is gzip-encoded, which MOS cannot read, so the worker makes no MOS call and the page is served as it is.',
        env: ENV,
        request: req(),
        origin: origin({
            headers: [
                ['content-type', 'text/html; charset=utf-8'],
                ['content-encoding', 'gzip'],
            ],
            body: '(gzip bytes, not readable as text)',
        }),
        failDecisions: false,
        decisions: decisions(),
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
        note: 'A configured route merges the client JSON body with the resolved identity and http metadata, then calls MOS with the key. The JWT comes from the cookie.',
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
        note: 'The decisions call fails, so the page is served as fetched, untouched and with no anon cookie.',
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
