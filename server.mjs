// Static server for the playground, plus an optional pass-through to a real MOS org
// ("live mode").
//
// The proxy injects nothing. It exists only to get past CORS: the browser cannot call a
// host that sends no Access-Control-Allow-Origin. Whatever auth the worker itself set is
// forwarded verbatim, so MOS receives exactly what the worker built. Live mode uses a
// publishable token, so nothing secret passes through here or sits in the browser.
//
// Safety posture: binds loopback only and refuses any target outside the configured MOS
// host, so it cannot be used as an open relay. Set MOS_DECISIONS_ONLY=true to also block
// custom endpoints and authenticated routes, which can write to a real org.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('./web/dist/', import.meta.url).pathname;
const ENV_FILE = new URL('./.env.local', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8787);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.map': 'application/json',
};

// ---------- live config ----------

function parseEnvFile(path) {
    const out = {};
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

const fileEnv = parseEnvFile(ENV_FILE);
const pick = (name) => process.env[name] ?? fileEnv[name];

const LIVE = (() => {
    const host = pick('MOS_HOST');
    const slug = pick('MOS_SURFACE_SLUG');
    if (!host || !slug) return { available: false };

    return {
        available: true,
        mosHost: host.replace(/\/$/, ''),
        surfaceSlug: slug,
        // Publishable token — safe in the browser, which is why it is handed out below.
        token: pick('MOS_TOKEN') ?? '',
        environment: pick('MOS_ENVIRONMENT') ?? '',
        decisionsOnly: String(pick('MOS_DECISIONS_ONLY') ?? '').toLowerCase() === 'true',
        originBase: pick('ORIGIN_BASE')?.replace(/\/$/, '') ?? null,
    };
})();

const publicLiveConfig = () => (LIVE.available
    ? {
        available: true,
        mosHost: LIVE.mosHost,
        surfaceSlug: LIVE.surfaceSlug,
        token: LIVE.token,
        environment: LIVE.environment,
        decisionsOnly: LIVE.decisionsOnly,
        originBase: LIVE.originBase,
    }
    : { available: false, reason: 'No .env.local — set MOS_HOST, MOS_SURFACE_SLUG and MOS_TOKEN to enable live mode.' });

const DECISIONS_PATH = '/api/v1/surface-decisions';

/** Only the configured MOS host, and only reads unless writes are unlocked. */
function vetTarget(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { return { ok: false, reason: `not a URL: ${rawUrl}` }; }

    const base = new URL(LIVE.mosHost);
    if (url.protocol !== base.protocol || url.host !== base.host) {
        return { ok: false, reason: `target ${url.host} is not the configured MOS host ${base.host}` };
    }
    if (LIVE.decisionsOnly && url.pathname !== DECISIONS_PATH) {
        return { ok: false, reason: `${url.pathname} blocked by MOS_DECISIONS_ONLY` };
    }
    return { ok: true, url };
}

const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
});

/** Forwards one worker fetch to MOS verbatim — no credentials added or altered. */
async function liveFetch(call) {
    const vet = vetTarget(call.url);
    if (!vet.ok) return { errorKind: 'transport', errorMessage: vet.reason };

    const headers = new Headers();
    for (const [name, value] of call.headers ?? []) {
        if (['host', 'content-length', 'connection'].includes(name.toLowerCase())) continue;
        headers.append(name, value);
    }

    const controller = new AbortController();
    // Mirrors the host's 2 s fetch budget.
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
        const res = await fetch(vet.url, {
            method: call.method ?? 'GET',
            headers,
            body: call.body == null || call.method === 'GET' ? undefined : call.body,
            signal: controller.signal,
        });
        return {
            status: res.status,
            headers: [...res.headers].filter(([n]) => n !== 'set-cookie'),
            body: await res.text(),
        };
    } catch (error) {
        return {
            errorKind: error.name === 'AbortError' ? 'timeout' : 'transport',
            errorMessage: error.name === 'AbortError' ? 'exceeded the 2s host fetch budget' : error.message,
        };
    } finally {
        clearTimeout(timer);
    }
}

/** Fetches real origin HTML so live runs can rewrite a real page. */
async function liveOrigin(path) {
    if (!LIVE.originBase) return { error: 'ORIGIN_BASE is not set in .env.local' };
    let url;
    try { url = new URL(path, LIVE.originBase + '/'); } catch { return { error: `bad path: ${path}` }; }
    if (new URL(LIVE.originBase).host !== url.host) return { error: 'path escaped ORIGIN_BASE' };

    try {
        const res = await fetch(url, { headers: { 'user-agent': 'mos-edge-worker-playground' } });
        return {
            status: res.status,
            headers: [...res.headers].filter(([n]) => ['content-type', 'etag', 'cache-control'].includes(n)),
            body: await res.text(),
            url: url.toString(),
        };
    } catch (error) {
        return { error: error.message };
    }
}

// ---------- server ----------

const json = (res, code, value) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
};

createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = normalize(decodeURIComponent(url.pathname));

    if (path === '/live/config') return json(res, 200, publicLiveConfig());

    if (path === '/live/fetch') {
        if (req.method !== 'POST') return json(res, 405, { errorKind: 'transport', errorMessage: 'POST only' });
        if (!LIVE.available) return json(res, 200, { errorKind: 'transport', errorMessage: 'live mode is not configured' });
        let call;
        try { call = JSON.parse(await readBody(req)); } catch { return json(res, 400, { errorKind: 'transport', errorMessage: 'bad JSON' }); }
        const result = await liveFetch(call);
        console.log(`  live → ${call.method} ${call.url} :: ${result.errorKind ? `${result.errorKind} (${result.errorMessage})` : `HTTP ${result.status}`}`);
        return json(res, 200, result);
    }

    if (path === '/live/origin') {
        if (!LIVE.available) return json(res, 200, { error: 'live mode is not configured' });
        const result = await liveOrigin(url.searchParams.get('path') ?? '/');
        console.log(`  live origin → ${result.url ?? '(error)'} :: ${result.error ?? `HTTP ${result.status}`}`);
        return json(res, 200, result);
    }

    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end(`not found: ${path}`);
    }
// Loopback only: this process now holds a secret and can make authenticated calls.
}).listen(PORT, '127.0.0.1', () => {
    console.log(`playground: http://localhost:${PORT}`);
    if (LIVE.available) {
        console.log(`live mode:  ${LIVE.mosHost} · surface "${LIVE.surfaceSlug}"${LIVE.environment ? ` · env ${LIVE.environment}` : ''}`);
        console.log('            pass-through only — nothing injected, publishable token');
        console.log(`            scope ${LIVE.decisionsOnly ? 'decisions only (MOS_DECISIONS_ONLY=true)' : 'all MOS paths — writes reach the org'}`);
        if (LIVE.originBase) console.log(`            origin ${LIVE.originBase}`);
    } else {
        console.log('live mode:  off — see .env.local.example');
    }
});
