// Stands in for a real MOS org so live mode can be verified end to end. Records exactly
// what the worker sent, which is the point: nothing between the worker and the org
// should alter the request.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const STREAM_TYPE = 'application/vnd.mos.decision-stream.v1';
const received = [];
createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    writeFileSync('/tmp/fake-org-received.json', JSON.stringify(received, null, 2));

    if (req.url === '/api/v1/surface-decisions') {
        // A secret key streams the page after a JSON line, and MOS streams it back transformed.
        // A publishable one (live mode) sends plain JSON, so the decision is a header op instead.
        const streamed = req.headers['content-type'] === STREAM_TYPE;
        const newline = streamed ? body.indexOf('\n') : -1;
        const page = newline === -1 ? null : body.slice(newline + 1);
        const http = page === null ? { addHeaders: [{ name: 'x-mos-live', value: 'from-live-org' }] } : {};
        const after = page === null ? '' : `\n${page.replace('<body>', '<body><div id="from-live-org">LIVE ORG DECISION</div>')}`;
        res.writeHead(200, { 'content-type': streamed ? STREAM_TYPE : 'application/json' });
        res.end(JSON.stringify({
            status: 'success',
            identity: { identifier: 'live-anon-99', isAuthenticated: false, authType: 'anonymous', jwtClaims: {} },
            features: {},
            customer: { hasProducts: true },
            surfaceBehavior: { http },
            componentsSkipped: false,
            componentBehaviors: {},
        }) + after);
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
