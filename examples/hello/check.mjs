// Smallest possible worker test with the devkit: drive both phases, apply the rules
// with real lol-html, assert on final output.
import { readFileSync } from 'node:fs';
import { EdgeWorkerHost } from '../../devkit/host.mjs';
import { applyHtmlRules } from '../../devkit/rewrite.mjs';
import { PRESETS } from './presets.mjs';

const WASM = readFileSync(new URL('../../build/hello/release.wasm', import.meta.url));

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
};

async function run(preset) {
    const host = await new EdgeWorkerHost(WASM).init();
    const phase1 = await host.clientRequest(preset.request);
    if (phase1.shortCircuited) return { shortCircuited: true, status: phase1.status, body: phase1.body };

    const phase2 = await host.originResponse({
        status: preset.origin.status,
        headers: preset.origin.headers,
        snapshot: phase1,
    });
    return {
        shortCircuited: false,
        status: phase2.status,
        headers: phase2.headers,
        rules: phase2.rules,
        body: await applyHtmlRules(preset.origin.body, phase2.rules),
        originSawHeader: phase1.headers.get('x-hello-worker'),
    };
}

console.log('\nhello example');
let r = await run(PRESETS['Page view']);
eq('request header stamped for origin', r.originSawHeader, '1');
eq('worker read its own header back via resp.request', r.headers.get('x-hello-worker-saw-request'), 'yes');
eq('two rules installed', r.rules.length, 2);
eq('banner injected as first child of body', r.body.includes('<body><div id="hello-banner">rewritten at the edge</div>'), true);
eq('attribute set on html', r.body.includes('<html data-edge="hello">'), true);
eq('origin copy preserved', r.body.includes('Served by the origin'), true);

r = await run(PRESETS['Short-circuit (/edge-ping)']);
eq('edge-ping short-circuits', [r.shortCircuited, r.status, r.body], [true, 200, 'pong']);

r = await run(PRESETS['Non-HTML passthrough']);
eq('json response gets no rules', r.rules.length, 0);
eq('json body untouched', r.body, '{"untouched":true}');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
