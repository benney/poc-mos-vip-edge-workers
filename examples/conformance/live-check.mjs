const base = process.argv[2] ?? process.env.CONFORMANCE_URL;
if (!base) {
    console.error('usage: CONFORMANCE_URL=https://site.example npm run test:conformance:live');
    process.exit(1);
}

const routes = [
    '/__probe/snapshot',
    '/__probe/fetch-origin-phase',
    '/__probe/rules-in-request-phase',
    '/__probe/kv',
    '/__probe/body-marker',
    '/__probe/memory-256k',
    '/__probe/memory-512k',
    '/__probe/memory-1m',
    '/__probe/memory-2m',
    '/__probe/memory-4m',
    '/__probe/memory-8m',
];

for (const route of routes) {
    const response = await fetch(new URL(route, base));
    const body = (await response.text()).trim();
    console.log(`\n${response.status} ${route}`);
    for (const [name, value] of response.headers) {
        if (name.startsWith('x-probe-')) console.log(`${name}: ${value}`);
    }
    if (body) console.log(body);
}
