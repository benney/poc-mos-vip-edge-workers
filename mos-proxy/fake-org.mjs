// Stands in for a real MOS org so live mode can be verified end to end. Records exactly
// what the worker sent, which is the point: nothing between the worker and the org
// should alter the request.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const received = [];
createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    writeFileSync('/tmp/fake-org-received.json', JSON.stringify(received, null, 2));

    if (req.url === '/api/v1/surface-decisions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
            status: 'success',
            identity: { identifier: 'live-anon-99', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
            features: {},
            customer: { hasProducts: true },
            surfaceBehavior: {},
            componentsSkipped: false,
            componentBehaviors: {
                liveBanner: {
                    metadata: { cssSelector: '.article-body' },
                    content: { before: [{ type: 'html', content: '<div id="from-live-org">LIVE ORG DECISION</div>' }] },
                },
            },
        }));
        return;
    }
    if (req.url.startsWith('/page')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Live</title></head><body><article class="article-body"><p>Real origin copy.</p></article></body></html>');
        return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echoed: req.url }));
}).listen(8899, '127.0.0.1', () => console.log('fake org: http://localhost:8899'));
