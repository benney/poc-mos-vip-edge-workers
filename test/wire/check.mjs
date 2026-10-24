// Asserts devkit/host.mjs's JS msgpack codec against the SDK's own AssemblyScript
// codec, in both directions. If the SDK changes its wire format, this fails instead
// of the devkit silently diverging from the runtime.
import { readFileSync } from 'node:fs';
import { Reader, Writer } from '../../devkit/host.mjs';

const WASM = readFileSync(new URL('../../build/wire/release.wasm', import.meta.url));

const { instance } = await WebAssembly.instantiate(WASM, {
    env: {
        abort(msg, file, line, col) { throw new Error(`SDK codec aborted @ ${line}:${col}`); },
    },
});
const ex = instance.exports;
const ENC = new TextEncoder();
const DEC = new TextDecoder();

const put = (bytes) => {
    const ptr = ex.inAlloc(bytes.length);
    new Uint8Array(ex.memory.buffer, ptr, bytes.length).set(bytes);
    return [ptr, bytes.length];
};
const outBytes = () => new Uint8Array(ex.memory.buffer, ex.outPtr(), ex.outLen()).slice();
const outText = () => DEC.decode(outBytes());

let pass = 0, fail = 0;
const eq = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}\n       SDK      ${e}\n       devkit   ${a}`); }
};
const hex = (u8) => Buffer.from(u8).toString('hex');

// ---- direction 1: SDK encodes, devkit decodes ----

console.log('\nSDK writer -> devkit reader');
{
    ex.encodeRequestMeta(...put(ENC.encode('POST')), ...put(ENC.encode('/a/b?c=1')));
    const r = new Reader(outBytes());
    eq('request meta [method, url]', [r.array(), r.str(), r.str()], [2, 'POST', '/a/b?c=1']);
}
{
    for (const status of [0, 200, 127, 128, 404, 451, 599, 65535]) {
        ex.encodeResponseMeta(status);
        const r = new Reader(outBytes());
        eq(`response meta status=${status}`, [r.array(), r.uint()], [1, status]);
    }
}
{
    ex.encodePairs(...put(ENC.encode('content-type\ttext/html\nset-cookie\ta=1\nset-cookie\tb=2')));
    const r = new Reader(outBytes());
    eq('pair array preserves order and duplicates', r.pairs(),
        [['content-type', 'text/html'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']]);
}
{
    // 0xa0 fixstr <=31, 0xd9 str8 <=255, 0xda str16 beyond.
    for (const n of [0, 1, 31, 32, 255, 256, 300]) {
        ex.encodeStrOfLength(n);
        const bytes = outBytes();
        const r = new Reader(bytes);
        r.array();
        eq(`string of ${n} bytes (prefix 0x${bytes[1].toString(16)})`, r.str().length, n);
    }
}
{
    // 0x90 fixarray <=15, 0xdc array16 beyond.
    for (const n of [0, 15, 16, 100]) {
        ex.encodeArrayOfLength(n);
        const bytes = outBytes();
        const r = new Reader(bytes);
        eq(`array of ${n} entries (prefix 0x${bytes[0].toString(16)})`, r.array(), n);
    }
}
{
    ex.encodeFetchResponse(200, 0);
    let r = new Reader(outBytes());
    eq('fetch response, no error', [r.array(), r.uint(), r.pairs(), r.str(), r.str()],
        [4, 200, [['content-type', 'application/json']], null, null]);

    ex.encodeFetchResponse(0, 1);
    r = new Reader(outBytes());
    eq('fetch response, with error', [r.array(), r.uint(), r.pairs(), r.str(), r.str()],
        [4, 0, [['content-type', 'application/json']], 'timeout', 'took too long']);
}

// ---- direction 2: devkit encodes, SDK decodes ----

console.log('\ndevkit writer -> SDK reader');
{
    const bytes = new Writer().array(2).str('GET').str('/x?y=z').done();
    ex.decodeRequestMeta(...put(bytes));
    eq('SDK reads devkit request meta', outText(), 'size=2\nmethod=GET\nurl=/x?y=z');
}
{
    for (const status of [200, 127, 128, 503, 65535]) {
        ex.decodeResponseMeta(...put(new Writer().array(1).uint(status).done()));
        eq(`SDK reads devkit status=${status}`, outText(), `size=1\nstatus=${status}`);
    }
}
{
    // Exactly the shape devkit/host.mjs builds for env.fetch.
    const bytes = new Writer().array(3).str('POST').str('https://api.test/v1/x')
        .pairs([['content-type', 'application/json'], ['authorization', 'Bearer t']]).done();
    ex.decodeFetchRequest(...put(bytes));
    eq('SDK reads devkit fetch request', outText(),
        'size=3\nmethod=POST\nurl=https://api.test/v1/x\npairs=2'
        + '\ncontent-type\tapplication/json\nauthorization\tBearer t');
}
{
    for (const n of [0, 15, 16, 40]) {
        const pairs = Array.from({ length: n }, (_, i) => [`h${i}`, `v${i}`]);
        ex.decodePairs(...put(new Writer().pairs(pairs).done()));
        eq(`SDK reads devkit pair array of ${n}`, outText().split('\n')[0], `pairs=${n}`);
    }
}
{
    // Long values are what real headers look like; exercises str8/str16 both ways.
    for (const len of [31, 32, 255, 256, 1000]) {
        const value = 'v'.repeat(len);
        ex.decodePairs(...put(new Writer().pairs([['x', value]]).done()));
        eq(`SDK reads devkit ${len}-byte header value`, outText(), `pairs=1\nx\t${value}`);
    }
}
{
    // Multi-byte UTF-8 must agree byte-for-byte, since lengths are in bytes not chars.
    const value = 'héllo wörld 🎉 日本語';
    ex.decodePairs(...put(new Writer().pairs([['x-utf8', value]]).done()));
    eq('SDK reads devkit multi-byte UTF-8', outText(), `pairs=1\nx-utf8\t${value}`);

    ex.encodePairs(...put(ENC.encode(`x-utf8\t${value}`)));
    eq('devkit reads SDK multi-byte UTF-8', new Reader(outBytes()).pairs(), [['x-utf8', value]]);
}

// ---- byte-identical encodings ----

console.log('\nbyte-for-byte agreement');
{
    ex.encodeRequestMeta(...put(ENC.encode('PATCH')), ...put(ENC.encode('/same')));
    const sdk = hex(outBytes());
    const devkit = hex(new Writer().array(2).str('PATCH').str('/same').done());
    eq('request meta bytes identical', devkit, sdk);

    ex.encodeResponseMeta(418);
    eq('response meta bytes identical', hex(new Writer().array(1).uint(418).done()), hex(outBytes()));

    ex.encodePairs(...put(ENC.encode('a\t1\nb\t2')));
    eq('pair array bytes identical', hex(new Writer().pairs([['a', '1'], ['b', '2']]).done()), hex(outBytes()));

    ex.encodeStrOfLength(300);
    eq('str16 bytes identical', hex(new Writer().array(1).str('a'.repeat(300)).done()), hex(outBytes()));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
