// Drives live mode in headless Chrome against web/fake-org.mjs, which stands in for a
// real MOS org. Asserts what the org actually received, so the pass-through is proven
// to alter nothing. Requires Chrome at the path below; not part of `npm run test:all`.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findChrome } from '../devkit/chrome.mjs';
const CHROME = findChrome();
const PORT = 9228;

// Self-contained: spawn the fake org and the playground server with live env vars set.
// server.mjs prefers process.env over .env.local, so a developer's own config is untouched.
const LIVE_ENV = {
    ...process.env,
    MOS_HOST: 'http://localhost:8899',
    MOS_SURFACE_SLUG: 'live-surface',
    MOS_TOKEN: 'pk_test_live123',
    MOS_ENVIRONMENT: 'test_live123',
    ORIGIN_BASE: 'http://localhost:8899',
};
const org = spawn(process.execPath, [new URL('./fake-org.mjs', import.meta.url).pathname], { stdio: 'ignore' });
const srv = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], { env: LIVE_ENV, stdio: 'ignore' });
const shutdown = () => { for (const p of [org, srv, chrome]) { try { p.kill('SIGKILL'); } catch {} } };
process.on('exit', shutdown);
await new Promise((r) => setTimeout(r, 1500));
for (let i = 0; i < 40; i++) {
    try { if ((await fetch('http://localhost:8787/live/config')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
}
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 60; i++) {
    try {
        const l = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
        const p = l.find((t) => t.type === 'page');
        if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(250);
}
await new Promise((r) => { ws.onopen = r; });
let id = 0; const inflight = new Map(); const errors = [];
ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && inflight.has(m.id)) { const s = inflight.get(m.id); inflight.delete(m.id); m.error ? s.rej(new Error(JSON.stringify(m.error))) : s.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; inflight.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw');
    return r.result.value;
};
const waitOk = async () => {
    for (let i = 0; i < 120; i++) {
        await sleep(200);
        const s = await ev(`document.getElementById('status').textContent`).catch(() => '');
        if (s === 'ok' || /invalid|failed|abort/i.test(s)) return s;
    }
    return '(timeout)';
};
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `\n       ${d}` : ''}`); } };

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://localhost:8787' });
await waitOk();

console.log('enable live mode');
await ev(`(() => { const c = document.getElementById('live'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
let s = await waitOk();
ok('run succeeded in live mode', s === 'ok', s);

let st = await ev(`(() => ({
  checked: document.getElementById('live').checked,
  note: document.getElementById('liveNote').textContent,
  env: document.getElementById('env').value,
  decisionsReadOnly: document.getElementById('decisions').readOnly,
  badges: [...document.querySelectorAll('.badge')].map(b => b.textContent),
  body: [...document.querySelectorAll('.card')].find(c => c.querySelector('h3')?.textContent === 'Final response')?.textContent ?? '',
  mosCallCard: [...document.querySelectorAll('.card')].find(c => (c.querySelector('h3')?.textContent ?? '').startsWith('API call'))?.textContent ?? '',
}))()`);
ok('toggle stayed on', st.checked === true);
ok('note names the live host', st.note.includes('localhost:8899'), st.note);
ok('note warns writes reach the org', /writes reach the org/.test(st.note), st.note);
ok('env rewritten with live host', st.env.includes('MOS_HOST=http://localhost:8899'));
ok('env carries publishable token', st.env.includes('MOS_SECRET_KEY=pk_test_live123'));
ok('env carries MOS_ENVIRONMENT', st.env.includes('MOS_ENVIRONMENT=test_live123'));
ok('decisions editor is read-only', st.decisionsReadOnly === true);
ok('LIVE API badge shown', st.badges.includes('LIVE API'), st.badges.join('|'));
ok('real org decision applied to html', st.body.includes('from-live-org'));
ok('real response body shown in API call card', st.mosCallCard.includes('live-anon-99'));

console.log('\nwhat the org actually received');
const got = JSON.parse(readFileSync('/tmp/fake-org-received.json', 'utf8'));
const decisionsCall = got.find((g) => g.url === '/api/v1/surface-decisions');
ok('org got the decisions call', !!decisionsCall);
ok('worker built its own Bearer token', decisionsCall.headers.authorization === 'Bearer pk_test_live123', decisionsCall.headers.authorization);
ok('proxy did not inject anything else', !('x-injected' in decisionsCall.headers));
ok('proxy forwarded proxy-version header', decisionsCall.headers['x-mos-proxy-version'] === '1.5.1');
const sent = JSON.parse(decisionsCall.body);
ok('surface slug from live config', sent.surfaceSlug === 'live-surface', sent.surfaceSlug);
ok('no sk_ key anywhere in the request', !JSON.stringify(decisionsCall).includes('sk_'));

console.log('\nreal origin fetch');
await ev(`(() => { document.getElementById('url').value = '/page'; const c = document.getElementById('liveOrigin'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
s = await waitOk();
ok('run with real origin succeeded', s === 'ok', s);
st = await ev(`(() => ({
  originBody: document.getElementById('originBody').value,
  final: [...document.querySelectorAll('.card')].find(c => c.querySelector('h3')?.textContent === 'Final response')?.textContent ?? '',
}))()`);
ok('origin html pulled from the org', st.originBody.includes('Real origin copy.'), st.originBody.slice(0, 80));
ok('live decision rewrote the real page', st.final.includes('from-live-org') && st.final.includes('Real origin copy.'));

console.log('\nsk_ key guard');
await ev(`(() => { const e = document.getElementById('env');
  e.value = e.value.replace(/MOS_SECRET_KEY=.*/, 'MOS_SECRET_KEY=sk_live_realsecret');
  document.getElementById('run').click(); })()`);
await sleep(1500);
st = await ev(`(() => ({
  hidden: document.getElementById('skWarning').hidden,
  text: document.getElementById('skWarning').textContent,
}))()`);
ok('warns when an sk_ key is pasted', st.hidden === false, JSON.stringify(st));
ok('names the offending var', /MOS_SECRET_KEY/.test(st.text), st.text);

console.log(errors.length ? `\nexceptions:\n${errors.join('\n')}` : '\nno page exceptions');
ws.close();
shutdown();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
