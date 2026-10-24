// Main-thread UI. All wasm work happens in the Web Worker; this only edits inputs
// and renders what came back.
import { PRESETS } from '#presets';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
};

let worker = null;
let nextId = 1;
const pending = new Map();

// ---------- input serialisation ----------

const envToText = (env) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
const textToEnv = (text) => {
    const out = {};
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
};

const headersToText = (pairs) => pairs.map(([n, v]) => `${n}: ${v}`).join('\n');
const textToHeaders = (text) => {
    const out = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        out.push([trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim()]);
    }
    return out;
};

function loadPreset(name) {
    const preset = PRESETS[name];
    $('note').textContent = preset.note;
    $('env').value = envToText(preset.env);
    $('method').value = preset.request.method;
    $('url').value = preset.request.url;
    $('reqHeaders').value = headersToText(preset.request.headers);
    $('reqBody').value = preset.request.body ?? '';
    $('originStatus').value = preset.origin.status;
    $('originHeaders').value = headersToText(preset.origin.headers);
    $('originBody').value = preset.origin.body;
    $('decisions').value = JSON.stringify(preset.decisions, null, 2);
    $('failDecisions').checked = preset.failDecisions;
}

let liveConfig = null;

async function loadLiveConfig() {
    if (liveConfig) return liveConfig;
    liveConfig = await (await fetch('/live/config')).json();
    return liveConfig;
}

/** Live mode rewrites the env panel from the server config, so what the worker gets is visible. */
async function applyLiveMode(enabled) {
    const decisions = $('decisions');
    $('directWrap').hidden = !enabled;
    $('originWrap').hidden = !enabled;
    decisions.classList.toggle('ignored', enabled);
    decisions.readOnly = enabled;
    $('decisionsLabel').textContent = enabled
        ? 'Fake API response (ignored — the live API answers)'
        : 'Fake API response (JSON)';

    const note = $('liveNote');
    if (!enabled) {
        note.hidden = true;
        loadPreset($('preset').value);
        return true;
    }

    const cfg = await loadLiveConfig();
    if (!cfg.available) {
        note.hidden = false;
        note.textContent = cfg.reason;
        $('live').checked = false;
        $('directWrap').hidden = true;
        $('originWrap').hidden = true;
        decisions.classList.remove('ignored');
        decisions.readOnly = false;
        return false;
    }

    note.hidden = false;
    note.textContent = `Live: ${cfg.mosHost} · ${cfg.surfaceSlug} · publishable token`
        + (cfg.decisionsOnly ? ' · decisions only' : ' · all paths (writes reach the org)');

    // Show exactly what the worker will read via getenv.
    const env = textToEnv($('env').value);
    env.MOS_HOST = cfg.mosHost;
    env.MOS_SURFACE_SLUG = cfg.surfaceSlug;
    env.MOS_SECRET_KEY = cfg.token;
    if (cfg.environment) env.MOS_ENVIRONMENT = cfg.environment;
    else delete env.MOS_ENVIRONMENT;
    $('env').value = envToText(env);
    return true;
}

async function maybeLoadRealOrigin() {
    if (!$('live').checked || !$('liveOrigin').checked) return;
    const path = $('url').value.trim() || '/';
    const res = await (await fetch(`/live/origin?path=${encodeURIComponent(path)}`)).json();
    if (res.error) { setStatus(`origin fetch failed: ${res.error}`, 'bad'); return; }
    $('originStatus').value = res.status;
    $('originHeaders').value = headersToText(res.headers);
    $('originBody').value = res.body;
}

/** This page runs in a browser: an sk_ key here would be exposed. */
function checkForSecretKey(env) {
    const warn = $('skWarning');
    const offenders = Object.entries(env)
        .filter(([, v]) => /(^|[^a-z])sk_(live|test|prod)/i.test(v))
        .map(([k]) => k);
    warn.hidden = offenders.length === 0;
    if (offenders.length) {
        warn.textContent = `${offenders.join(', ')} looks like an sk_ secret key. `
            + 'This page is a browser — use a publishable token instead.';
    }
    return offenders;
}

function readInput() {
    let decisions;
    try {
        decisions = JSON.parse($('decisions').value);
    } catch (error) {
        throw new Error(`decisions JSON is invalid: ${error.message}`);
    }
    const env = textToEnv($('env').value);
    checkForSecretKey(env);
    return {
        env,
        request: {
            method: $('method').value.trim() || 'GET',
            url: $('url').value.trim() || '/',
            headers: textToHeaders($('reqHeaders').value),
            body: $('reqBody').value,
        },
        origin: {
            status: Number($('originStatus').value) || 200,
            headers: textToHeaders($('originHeaders').value),
            body: $('originBody').value,
        },
        decisions,
        failDecisions: $('failDecisions').checked,
        mode: $('live').checked ? 'live' : 'fake',
        direct: $('liveDirect').checked,
    };
}

// ---------- rendering ----------

function card(title, subtitle) {
    const wrap = el('section', 'card');
    const head = el('header', 'card-head');
    head.appendChild(el('h3', null, title));
    if (subtitle) head.appendChild(el('span', 'pill', subtitle));
    wrap.appendChild(head);
    return wrap;
}

const pre = (text, cls) => el('pre', cls ? `code ${cls}` : 'code', text);

function renderHeaders(pairs) {
    if (!pairs.length) return pre('(none)');
    return pre(pairs.map(([n, v]) => `${n}: ${v}`).join('\n'));
}

function renderResult(result) {
    const out = $('output');
    out.textContent = '';

    // Outcome
    const outcome = card('Outcome');
    const badges = el('div', 'badges');
    const badge = (text, kind) => badges.appendChild(el('span', `badge ${kind}`, text));
    badge(result.mode === 'live' ? 'LIVE API' : 'fake API', result.mode === 'live' ? 'warn' : 'neutral');
    badge(result.outcome, result.outcome === 'short-circuited' ? 'warn' : 'good');
    badge(result.reachedOrigin ? 'reached origin' : 'origin not contacted', result.reachedOrigin ? 'neutral' : 'warn');
    badge(`HTTP ${result.final.status}`, result.final.status < 400 ? 'good' : 'warn');
    badge(`${result.mosCalls.length} API call${result.mosCalls.length === 1 ? '' : 's'}`, 'neutral');
    badge(`${result.rules.length} HTML rule${result.rules.length === 1 ? '' : 's'}`, 'neutral');
    outcome.appendChild(badges);
    out.appendChild(outcome);

    // Outbound API calls
    if (result.mosCalls.length) {
        for (const [i, entry] of result.mosCalls.entries()) {
            const c = card(`API call ${i + 1}`, `${entry.call.method} ${new URL(entry.call.url).pathname}`);
            c.appendChild(el('h4', 'sub', 'Request'));
            c.appendChild(pre(entry.call.url));
            c.appendChild(renderHeaders(entry.call.headers));
            if (entry.call.body) c.appendChild(pre(prettyJson(entry.call.body)));
            c.appendChild(el('h4', 'sub', 'Response'));
            if (entry.result.errorKind) {
                c.appendChild(pre(`error: ${entry.result.errorKind} — ${entry.result.errorMessage ?? ''}`, 'bad'));
            } else {
                c.appendChild(pre(`HTTP ${entry.result.status}`));
                if (entry.result.body) c.appendChild(pre(prettyJson(entry.result.body)));
            }
            out.appendChild(c);
        }
    } else {
        const c = card('API calls', 'none');
        c.appendChild(pre('The worker made no outbound call — gated before the decisions fetch.'));
        out.appendChild(c);
    }

    // Rules
    if (result.rules.length) {
        const c = card('HtmlRules submitted to host');
        c.appendChild(pre(result.rules.map((r) =>
            `${r.op}(${JSON.stringify(r.selector)}${r.args.length ? ', ' + r.args.map((a) => JSON.stringify(a)).join(', ') : ''})`).join('\n')));
        out.appendChild(c);
    }

    // Origin request
    if (result.originRequest) {
        const c = card('Request as origin saw it', `${result.originRequest.method} ${result.originRequest.url}`);
        c.appendChild(renderHeaders(result.originRequest.headers));
        out.appendChild(c);
    }

    // Final response
    const finalCard = card('Final response', `HTTP ${result.final.status}`);
    finalCard.appendChild(el('h4', 'sub', 'Headers'));
    finalCard.appendChild(renderHeaders(result.final.headers));
    finalCard.appendChild(el('h4', 'sub', 'Body'));
    finalCard.appendChild(pre(result.final.body ?? '(no body)'));
    out.appendChild(finalCard);

    // Rendered preview. sandbox="" blocks scripts, forms and navigation, so the
    // untrusted rewritten HTML can only paint.
    if (result.final.body && /<html|<body|<article|<div/i.test(result.final.body)) {
        const c = card('Rendered preview', 'sandboxed iframe');
        const frame = el('iframe', 'preview');
        frame.setAttribute('sandbox', '');
        c.appendChild(frame);
        out.appendChild(c);
        frame.srcdoc = result.final.body;
    }
}

function prettyJson(text) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function setStatus(text, kind = '') {
    const s = $('status');
    s.textContent = text;
    s.className = `status ${kind}`;
}

// ---------- worker plumbing ----------

function startWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = (event) => {
        const { type, id, result, message, stack, wasmBytes } = event.data;
        if (type === 'ready') {
            setStatus(`ready — worker binary ${(wasmBytes / 1024).toFixed(0)} KB`, 'good');
            $('run').disabled = false;
            run();
            return;
        }
        if (type === 'result') {
            pending.delete(id);
            setStatus('ok', 'good');
            renderResult(result);
            return;
        }
        if (type === 'error') {
            if (id) pending.delete(id);
            setStatus(message, 'bad');
            $('output').textContent = '';
            const c = card('Error');
            c.appendChild(pre(stack ?? message, 'bad'));
            $('output').appendChild(c);
        }
    };
    worker.onerror = (e) => setStatus(`worker failed: ${e.message}`, 'bad');
}

async function run() {
    try {
        await maybeLoadRealOrigin();
    } catch (error) {
        setStatus(`origin fetch failed: ${error.message}`, 'bad');
        return;
    }
    let input;
    try {
        input = readInput();
    } catch (error) {
        setStatus(error.message, 'bad');
        return;
    }
    const id = nextId++;
    pending.set(id, true);
    setStatus('running…');
    worker.postMessage({ type: 'run', id, input });
}

// ---------- boot ----------

const select = $('preset');
for (const name of Object.keys(PRESETS)) {
    select.appendChild(el('option', null, name)).value = name;
}
select.addEventListener('change', () => {
    loadPreset(select.value);
    if ($('live').checked) applyLiveMode(true).then(run);
    else run();
});
$('live').addEventListener('change', async () => {
    if (await applyLiveMode($('live').checked)) run();
});
$('liveDirect').addEventListener('change', run);
$('liveOrigin').addEventListener('change', run);
$('run').addEventListener('click', run);
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});

loadPreset(select.value);
setStatus('loading worker…');
startWorker();
