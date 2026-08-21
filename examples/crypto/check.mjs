// Drives the crypto example through the real wasm, so the four crypto.* host
// functions are exercised across the ABI rather than called directly.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EdgeWorkerHost } from '../../devkit/host.mjs';

const WASM = readFileSync(new URL('../../build/crypto/release.wasm', import.meta.url));
const NOW = 1_700_000_000; // fixed clock so `exp` assertions are stable

const ENV = { PAYLOAD_SIGNING_KEY: 'signing-key', SESSION_TOKEN_KEY: 'token-key' };

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
};

const b64url = (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function token(payload, { secret = ENV.SESSION_TOKEN_KEY, alg = 'HS256' } = {}) {
    const head = b64url(JSON.stringify({ alg, typ: 'JWT' }));
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(createHmac('sha256', secret).update(`${head}.${body}`).digest());
    return `${head}.${body}.${sig}`;
}

async function run({ url, headers = [], body = null }) {
    const host = await new EdgeWorkerHost(WASM, { env: ENV, now: NOW }).init();
    return host.clientRequest({ method: 'POST', url, headers, body });
}

console.log('\nsigned request (crypto.hmac_sha256 + crypto.constant_time_eq)');
{
    const payload = '{"event":"push"}';
    const good = 'sha256=' + createHmac('sha256', ENV.PAYLOAD_SIGNING_KEY).update(payload).digest('hex');

    let r = await run({ url: '/verify-signature', headers: [['x-payload-signature', good]], body: payload });
    eq('valid signature accepted', [r.status, r.body], [200, 'signature ok']);

    r = await run({ url: '/verify-signature', headers: [['x-payload-signature', good]], body: payload + 'x' });
    eq('tampered body rejected', [r.status, r.body], [401, 'signature mismatch']);

    r = await run({ url: '/verify-signature', headers: [['x-payload-signature', 'sha256=deadbeef']], body: payload });
    eq('wrong signature rejected', r.status, 401);

    r = await run({ url: '/verify-signature', body: payload });
    eq('absent signature header rejected', [r.status, r.body], [401, 'signature header absent']);
}

console.log('\nsession token (crypto.jwt_verify_hs256)');
{
    let r = await run({ url: '/session', headers: [['authorization', `Bearer ${token({ sub: 'u1', exp: NOW + 60 })}`]] });
    eq('valid token passes through to origin', r.shortCircuited, false);
    eq('payload forwarded as a header', JSON.parse(r.headers.get('x-session-payload')).sub, 'u1');

    r = await run({ url: '/session', headers: [['authorization', `Bearer ${token({ sub: 'u1', exp: NOW - 1 })}`]] });
    eq('expired token rejected', [r.status, r.body], [401, 'token rejected']);

    r = await run({ url: '/session', headers: [['authorization', `Bearer ${token({ sub: 'u1' }, { secret: 'wrong' })}`]] });
    eq('wrong key rejected', r.status, 401);

    r = await run({ url: '/session', headers: [['authorization', `Bearer ${token({ sub: 'u1' }, { alg: 'none' })}`]] });
    eq('non-HS256 alg rejected', r.status, 401);

    r = await run({ url: '/session', headers: [['authorization', 'Bearer not.a.token']] });
    eq('malformed token rejected', r.status, 401);

    r = await run({ url: '/session' });
    eq('absent bearer header rejected', [r.status, r.body], [401, 'bearer token absent']);

    r = await run({ url: '/session', headers: [['authorization', `Bearer ${token({ sub: 'u1' })}`]] });
    eq('no exp claim is accepted', r.shortCircuited, false);
}

console.log('\ndigest (crypto.sha256)');
{
    for (const payload of ['', 'abc', 'x'.repeat(1000)]) {
        const r = await run({ url: '/digest', body: payload });
        eq(`sha256 of ${payload.length} bytes matches node:crypto`,
            r.body, createHash('sha256').update(payload).digest('hex'));
    }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
