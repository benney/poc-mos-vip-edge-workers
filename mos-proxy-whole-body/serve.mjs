// Serves the compiled whole-body worker over HTTP with real fetches, as the edge would:
// onClientRequest, an in-memory cache, the origin on a miss, then onClientResponse.
// Without ORIGIN_URL it also starts a demo article origin and uses that.
//
//   MOS_HOST=http://localhost:4621 MOS_SURFACE_SLUG=news MOS_SECRET_KEY=sk_... node mos-proxy-whole-body/serve.mjs
//
// EDGE_PORT (default 4700) is the site; ORIGIN_PORT (default 4701) is the demo origin.
// CACHE_TTL_MS (default 60000) is how long a page stays cached.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { EdgeWorkerHost } from '../devkit/host.mjs';

const WASM = readFileSync(new URL('../build/mos-proxy-whole-body/release.wasm', import.meta.url));
const EDGE_PORT = Number(process.env.EDGE_PORT ?? 4700);
const ORIGIN_PORT = Number(process.env.ORIGIN_PORT ?? 4701);

const ARTICLE = `<!doctype html>
<html><head><meta charset="utf-8"><title>The tide tables are wrong</title>
<meta name="category" content="science"><meta name="author" content="A. Reporter">
<style>
body { font: 18px/1.6 Georgia, serif; max-width: 680px; margin: 110px auto 40px; color: #222; padding: 0 16px; }
h1 { font-size: 34px; line-height: 1.2; } .byline { color: #777; font-size: 15px; }
.paywall { border: 2px solid #1a56db; border-radius: 10px; padding: 24px; background: #eef4ff; font-family: system-ui, sans-serif; }
.paywall h2 { margin-top: 0; } .paywall a { display: inline-block; background: #1a56db; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; }
</style></head>
<body>
<h1>The tide tables are wrong</h1>
<p class="byline">By A. Reporter · Science</p>
<article class="post">
<p class="lede">For a century, harbour masters trusted the printed tables. This spring, three of them noticed the water arriving early.</p>
<p>The first discrepancy was eleven minutes, recorded in a logbook that nobody had digitised since 1987.</p>
<p>By June the gap had grown to twenty-six minutes, and the port authority quietly commissioned a survey.</p>
<p>What the survey found has implications for every coastal city that plans around the tide.</p>
</article>
</body></html>`;

/** The edge's own network: what fetch() reaches from inside the worker. */
async function realFetch({ method, url, headers, body }) {
    try {
        const res = await fetch(url, { method, headers, body: body ?? undefined, redirect: 'manual' });
        const text = await res.text();
        if (process.env.DEBUG_EDGE && url.includes('surface-decisions')) {
            try { const d = JSON.parse(text); const b = d.surfaceBehavior?.http?.body; if (b) d.surfaceBehavior.http.body = `<${b.length} chars>`; console.log('DEBUG', JSON.stringify(d)); } catch { console.log('DEBUG', text.slice(0, 500)); }
        }
        return { status: res.status, headers: [...res.headers], body: text };
    } catch (error) {
        return { errorKind: 'transport', errorMessage: String(error?.cause ?? error) };
    }
}

const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null));
});

const send = (res, status, headers, body) => {
    res.writeHead(status, headers);
    res.end(body ?? undefined);
};

const originUrl = process.env.ORIGIN_URL ?? `http://localhost:${ORIGIN_PORT}`;
const env = process.env;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 60_000);
// Keyed by URL and Accept-Encoding; the origin's own Cache-Control is ignored, as a CDN override would.
const cache = new Map();

if (!process.env.ORIGIN_URL) {
    createServer((req, res) => {
        if (req.url === '/' || req.url.startsWith('/story')) {
            return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, ARTICLE);
        }
        send(res, 404, { 'content-type': 'text/plain' }, 'not found');
    }).listen(ORIGIN_PORT, () => console.log(`origin  http://localhost:${ORIGIN_PORT}`));
}

createServer(async (req, res) => {
    const started = performance.now();
    const headers = Object.entries(req.headers).flatMap(([n, v]) => (Array.isArray(v) ? v.map((x) => [n, x]) : [[n, v]]));
    const body = await readBody(req);
    // A fresh instance per request: the stub runtime never frees memory.
    const host = await new EdgeWorkerHost(WASM, { env, fetchHandler: realFetch }).init();
    const out = await host.clientRequest({ method: req.method, url: req.url, headers, body });

    let served;
    if (out.shortCircuited) {
        served = { status: out.status, headers: out.headers.entries(), body: out.body, how: 'short-circuit' };
    } else {
        const key = `${out.url}|${out.headers.get('accept-encoding') ?? ''}`;
        const hit = req.method === 'GET' ? cache.get(key) : undefined;
        let stored = hit && hit.expires > Date.now() ? hit.response : undefined;
        const how = stored ? 'cache HIT' : 'cache MISS';
        if (!stored) {
            const upstream = await realFetch({ method: out.method, url: originUrl + out.url, headers: out.headers.entries(), body: out.body });
            if (upstream.errorKind) return send(res, 502, { 'content-type': 'text/plain' }, upstream.errorMessage);
            stored = { ...upstream, headers: upstream.headers.filter(([n]) => n !== 'content-length' && n !== 'content-encoding') };
            if (req.method === 'GET' && stored.status === 200) cache.set(key, { response: stored, expires: Date.now() + CACHE_TTL_MS });
        }
        const final = await host.clientResponse({ status: stored.status, headers: stored.headers, body: stored.body, snapshot: { method: req.method, url: req.url, headers } });
        served = { status: final.status, headers: final.headers.entries(), body: final.body, how };
    }

    const h = {};
    for (const [n, v] of served.headers) if (n !== 'content-length') (h[n] ??= []).push(v);
    send(res, served.status, h, served.body);

    // The devkit reruns a phase once per fetch, so earlier fetches appear once per rerun.
    const fetches = [...new Map(host.log.filter((e) => e.type === 'fetch').map((e) => [`${e.call.method} ${e.call.url}`, e.result])).entries()].map(
        ([call, r]) => `${call} -> ${r.status ?? r.errorKind}${r.status >= 400 ? ` ${String(r.body).slice(0, 200)}` : ''}`,
    );
    console.log(`${req.method} ${req.url} ${served.status} ${served.how} ${(performance.now() - started).toFixed(0)}ms`);
    for (const f of fetches) console.log(`    ${f}`);
}).listen(EDGE_PORT, () => console.log(`edge    http://localhost:${EDGE_PORT}  (MOS ${env.MOS_HOST ?? 'unset'}, origin ${originUrl})`));
