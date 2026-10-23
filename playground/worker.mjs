// Web Worker: owns the wasm host and lol-html. Both need synchronous WebAssembly
// compilation of modules far larger than the 4 KB main-thread cap, so all of it lives
// here and the UI talks to it over postMessage.
import { EdgeWorkerHost } from '../devkit/host.mjs';
import { applyHtmlRules } from '../devkit/rewrite.mjs';

let WASM = null;

const MOS_ORIGIN_FALLBACK = { status: 200, headers: [['content-type', 'application/json']], body: '{"ok":true}' };

/** Fake MOS API: decisions come from the UI, other paths get an echo response. */
function makeMosApi(input, trace) {
    return async (call) => {
        const path = call.url.replace(/^https?:\/\/[^/]+/, '');
        let result;

        if (path === '/api/v1/surface-decisions') {
            if (input.failDecisions) {
                result = { errorKind: 'timeout', errorMessage: 'simulated upstream timeout' };
            } else {
                result = {
                    status: 200,
                    headers: [['content-type', 'application/json']],
                    body: JSON.stringify(input.decisions),
                };
            }
        } else if (path.startsWith('/api/v1/envs/')) {
            result = {
                status: 200,
                headers: [['content-type', 'application/json'], ['x-mos-endpoint', 'echo']],
                body: JSON.stringify({ proxiedTo: path, method: call.method, receivedBody: safeJson(call.body) }, null, 2),
            };
        } else {
            result = {
                status: 201,
                headers: [['content-type', 'application/json']],
                body: JSON.stringify({ proxiedTo: path, receivedBody: safeJson(call.body) }, null, 2),
            };
        }

        trace.mosCalls.push({ call, result });
        return result ?? MOS_ORIGIN_FALLBACK;
    };
}

/**
 * Live mode: the worker's own request goes to the real MOS org. Nothing is rewritten —
 * the Authorization header the worker built (a publishable token) is what MOS receives.
 * Default route is the local pass-through, which exists only to get past CORS.
 */
function makeLiveApi(input, trace) {
    return async (call) => {
        let result;
        if (input.direct) {
            try {
                const res = await fetch(call.url, {
                    method: call.method,
                    headers: new Headers(call.headers.filter(([n]) => !['host', 'content-length'].includes(n))),
                    body: call.method === 'GET' || call.body == null ? undefined : call.body,
                });
                result = { status: res.status, headers: [...res.headers], body: await res.text() };
            } catch (error) {
                result = {
                    errorKind: 'transport',
                    errorMessage: `${error.message} — usually CORS. Uncheck "direct" to use the local pass-through.`,
                };
            }
        } else {
            const res = await fetch(new URL('live/fetch', self.location.href), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(call),
            });
            result = await res.json();
        }
        trace.mosCalls.push({ call, result });
        return result;
    };
}

function safeJson(text) {
    if (text == null) return null;
    try { return JSON.parse(text); } catch { return text; }
}

async function run(input) {
    const trace = { mosCalls: [], mode: input.mode ?? 'fake' };
    const host = await new EdgeWorkerHost(WASM, {
        env: input.env,
        fetchHandler: input.mode === 'live' ? makeLiveApi(input, trace) : makeMosApi(input, trace),
    }).init();

    const phase1 = await host.clientRequest({
        method: input.request.method,
        url: input.request.url,
        headers: input.request.headers,
        body: input.request.body || null,
    });

    if (phase1.shortCircuited) {
        return {
            outcome: 'short-circuited',
            mode: trace.mode,
            reachedOrigin: false,
            mosCalls: trace.mosCalls,
            rules: [],
            final: {
                status: phase1.status,
                headers: phase1.headers.entries(),
                body: phase1.body,
            },
        };
    }

    const originReq = {
        method: phase1.method,
        url: phase1.url,
        headers: phase1.headers,
        body: phase1.body,
    };

    // The page as VIP serves it, from cache or origin, goes through onClientResponse.
    const phase2 = await host.clientResponse({
        status: input.origin.status,
        headers: input.origin.headers,
        body: input.origin.body,
        snapshot: { method: input.request.method, url: input.request.url, headers: input.request.headers },
    });

    const replaced = phase2.body != null && phase2.body !== input.origin.body;
    const html = await applyHtmlRules(phase2.body ?? input.origin.body, phase2.rules);

    return {
        outcome: replaced ? 'replaced' : phase2.rules.length > 0 ? 'rewritten' : 'passed through',
        mode: trace.mode,
        reachedOrigin: true,
        mosCalls: trace.mosCalls,
        originRequest: {
            method: originReq.method,
            url: originReq.url,
            headers: originReq.headers.entries(),
        },
        rules: phase2.rules,
        final: {
            status: phase2.status,
            headers: phase2.headers.entries(),
            body: html,
        },
        originalBody: input.origin.body,
    };
}

self.onmessage = async (event) => {
    const { type, input, id } = event.data;
    if (type !== 'run') return;
    try {
        const result = await run(input);
        self.postMessage({ type: 'result', id, result });
    } catch (error) {
        self.postMessage({ type: 'error', id, message: error.message, stack: error.stack });
    }
};

// The worker binary is fetched relative to this bundle.
fetch(new URL('release.wasm', self.location.href))
    .then((r) => {
        if (!r.ok) throw new Error(`could not load release.wasm (HTTP ${r.status}) — run \`npm run build\` first`);
        return r.arrayBuffer();
    })
    .then((bytes) => {
        WASM = bytes;
        self.postMessage({ type: 'ready', wasmBytes: bytes.byteLength });
    })
    .catch((error) => self.postMessage({ type: 'error', message: error.message }));
