// Playground scenarios for the `hello` example.

const ORIGIN_HTML = `<!doctype html>
<html>
<head><title>Hello</title></head>
<body>
  <h1>Origin page</h1>
  <p>Served by the origin, rewritten at the edge.</p>
</body>
</html>`;

const origin = (over = {}) => ({
    status: 200,
    headers: [['content-type', 'text/html; charset=utf-8']],
    body: ORIGIN_HTML,
    ...over,
});

export const PRESETS = {
    'Page view': {
        note: 'The worker stamps a request header, reads it back in onOriginResponse via resp.request, then injects a banner with HtmlRules.',
        env: {},
        request: { method: 'GET', url: '/', headers: [['host', 'example.com']], body: '' },
        origin: origin(),
        failDecisions: false,
        decisions: {},
    },
    'Short-circuit (/edge-ping)': {
        note: 'req.respondText() in the request phase replies immediately — origin is never contacted.',
        env: {},
        request: { method: 'GET', url: '/edge-ping', headers: [['host', 'example.com']], body: '' },
        origin: origin(),
        failDecisions: false,
        decisions: {},
    },
    'Non-HTML passthrough': {
        note: 'HtmlRules only apply to text/html, so a JSON response is left alone.',
        env: {},
        request: { method: 'GET', url: '/api/data', headers: [['host', 'example.com']], body: '' },
        origin: origin({ headers: [['content-type', 'application/json']], body: '{"untouched":true}' }),
        failDecisions: false,
        decisions: {},
    },
};
