// Runs the conformance probes against the devkit host and prints a report in the same
// shape as the deployed worker's output, so the two can be diffed directly.
//
//   local:    node examples/conformance/check.mjs
//   deployed: curl -sSD - https://<site>/__probe/snapshot -o /dev/null
//
// A difference means either the devkit is wrong or the host does something the SDK
// docs do not describe. Both are worth knowing before trusting a local test run.
import { readFileSync } from 'node:fs';
import { EdgeWorkerHost } from '../../devkit/host.mjs';
import { applyHtmlRules } from '../../devkit/rewrite.mjs';

const WASM = readFileSync(new URL('../../build/conformance/release.wasm', import.meta.url));
const HTML = '<!doctype html><html><body><p>probe</p></body></html>';

const ENV = { PROBE_FETCH_URL: 'https://example.test/ping' };

async function probe(path, { env = ENV, selector = null } = {}) {
    const host = await new EdgeWorkerHost(WASM, {
        env: selector ? { ...env, PROBE_SELECTOR: selector } : env,
        fetchHandler: async () => ({ status: 200, headers: [], body: 'pong' }),
    });
    await host.init();

    const req = await host.clientRequest({ method: 'GET', url: path, headers: [['host', 'probe.test']] });
    if (req.shortCircuited) return { shortCircuited: true, status: req.status, body: req.body };

    const res = await host.originResponse({
        status: 200,
        headers: [['content-type', 'text/html; charset=utf-8']],
        snapshot: req,
    });
    return {
        shortCircuited: false,
        status: res.status,
        headers: res.headers,
        rules: res.rules,
        html: await applyHtmlRules(HTML, res.rules),
        requestHeadersSentToOrigin: req.headers,
    };
}

const report = [];
const record = (name, value, modelled = true) => {
    report.push({ name, value, modelled });
    const flag = modelled ? '' : '   [not modelled by the devkit]';
    console.log(`  ${name.padEnd(42)} ${value}${flag}`);
};

console.log('\ncross-phase request snapshot');
{
    const r = await probe('/__probe/snapshot');
    record('origin-phase sees request-phase mark', r.headers.get('x-probe-origin-phase-sees-mark'));
    record('origin-phase snapshot url', r.headers.get('x-probe-origin-phase-url'));
    record('mark reached origin', r.requestHeadersSentToOrigin.get('x-probe-mark') ?? 'no');
    // onClientResponse is a separate phase the devkit does not drive; the deployed
    // worker will fill this in.
    record('client-phase sees request-phase mark', '(deploy to observe)', false);
}

console.log('\nfetch() phase gating');
{
    const r = await probe('/__probe/fetch-client-phase');
    record('client-request phase: isError', JSON.parse(JSON.stringify(parseKv(r.body).isError ?? '?')));
    record('client-request phase: status', parseKv(r.body).status ?? '?');

    const o = await probe('/__probe/fetch-origin-phase');
    record('origin-response phase: isError', o.headers.get('x-probe-origin-fetch-iserror') ?? '(absent)');
    record('origin-response phase: errorKind', o.headers.get('x-probe-origin-fetch-errorkind') ?? '(absent)');
}

console.log('\nHtmlRules registered in a request phase');
{
    const r = await probe('/__probe/rules-in-request-phase');
    const applied = r.html.includes('REQUEST-PHASE-RULE');
    record('rules collected from request phase', String(r.rules.length));
    record('marker present in final html', applied ? 'yes' : 'no');
}

console.log('\nselector support (lol-html subset)');
for (const sel of ['p', 'head script:first-of-type', 'div:last-child', 'li:nth-child(2)', 'a[href^="/"]']) {
    try {
        const r = await probe('/__probe/selector', { selector: sel });
        record(`install ${JSON.stringify(sel)}`, r.headers.get('x-probe-selector-installed') ? 'ok' : 'no rule');
    } catch (error) {
        record(`install ${JSON.stringify(sel)}`, `threw: ${error.message.slice(0, 60)}`);
    }
}

console.log('\nKV');
{
    const r = await probe('/__probe/kv');
    const kv = parseKv(r.body);
    record('kv.setText then getText', kv['kv.setText+getText'] ?? '?');
    record('kv.incr (must be 1, not 2)', kv['kv.incr'] ?? '?');
}

console.log('\nrequest body without the marker');
{
    const r = await probe('/__probe/body-marker');
    record('req.body when marker not exported', parseKv(r.body)['req.body'] ?? '?');
}

console.log('\nlinear-memory allocation probes (local host)');
for (const path of [
    '/__probe/memory-256k',
    '/__probe/memory-512k',
    '/__probe/memory-1m',
    '/__probe/memory-2m',
    '/__probe/memory-4m',
    '/__probe/memory-8m',
]) {
    try {
        const r = await probe(path);
        const values = parseKv(r.body);
        record(`${path} result`, `${r.status} ${values.status ?? '?'}`, false);
        record(`${path} bytes`, values.bytes ?? '?', false);
    } catch (error) {
        record(`${path} result`, `threw: ${error.message.slice(0, 60)}`, false);
    }
}

function parseKv(text) {
    const out = {};
    for (const l of (text ?? '').split('\n')) {
        const i = l.indexOf('=');
        if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
    }
    return out;
}

const unmodelled = report.filter((r) => !r.modelled).length;
console.log(`\n${report.length} probes recorded, ${unmodelled} not modelled locally.`);
console.log('Deploy examples/conformance and diff against this to validate the devkit.\n');
