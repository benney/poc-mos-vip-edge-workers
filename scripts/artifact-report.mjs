import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ROOT, listWorkers } from './paths.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const selected = new Set(args.filter((arg) => !arg.startsWith('-')));

function limit(name) {
    const value = process.env[name];
    if (value === undefined) return null;
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
    return Number(value);
}

const maxWasmBytes = limit('MAX_WASM_BYTES');
const maxMemoryBytes = limit('MAX_WASM_MEMORY_BYTES');
// The deployable is the root worker. Name others (`hello`, `conformance`) to report them too.
const workers = listWorkers()
    .filter(({ name, dir }) => (selected.size ? selected.has(name) || selected.has(dir) : dir === '.'))
    .map(({ name, dir }) => ({
        name,
        source: dir,
        artifact: resolve(ROOT, 'build', name, 'release.wasm'),
    }));

function formatBytes(bytes) {
    if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
    if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
    return `${bytes} B`;
}

function importsFor(module) {
    const imports = {};
    for (const item of WebAssembly.Module.imports(module)) {
        if (item.kind !== 'function') throw new Error(`unsupported ${item.kind} import ${item.module}.${item.name}`);
        (imports[item.module] ??= {})[item.name] = () => 0;
    }
    return imports;
}

async function inspect(artifact) {
    const bytes = readFileSync(artifact);
    const module = new WebAssembly.Module(bytes);
    const instance = await WebAssembly.instantiate(module, importsFor(module));
    const memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error('memory export is missing');
    const initialPages = memory.grow(0);
    return {
        bytes: statSync(artifact).size,
        initialPages,
        initialMemoryBytes: memory.buffer.byteLength,
        exports: WebAssembly.Module.exports(module)
            .map(({ name }) => name)
            .join(', '),
    };
}

let failed = false;
console.log('worker       wasm         startup memory       exports');
console.log('-----------  -----------  -------------------  -------');
for (const worker of workers) {
    if (!existsSync(worker.artifact)) {
        if (check) {
            failed = true;
            console.error(`${worker.name.padEnd(11)} missing ${relative(ROOT, worker.artifact)}`);
        }
        continue;
    }

    try {
        const result = await inspect(worker.artifact);
        console.log(
            `${worker.name.padEnd(11)} ${formatBytes(result.bytes).padEnd(11)}  ${formatBytes(result.initialMemoryBytes).padEnd(19)}  ${result.exports}`,
        );
        if (maxWasmBytes !== null && result.bytes > maxWasmBytes) {
            failed = true;
            console.error(`  ${worker.name}: ${result.bytes} B exceeds MAX_WASM_BYTES=${maxWasmBytes}`);
        }
        if (maxMemoryBytes !== null && result.initialMemoryBytes > maxMemoryBytes) {
            failed = true;
            console.error(
                `  ${worker.name}: ${result.initialMemoryBytes} B exceeds MAX_WASM_MEMORY_BYTES=${maxMemoryBytes}`,
            );
        }
    } catch (error) {
        failed = true;
        console.error(`${worker.name.padEnd(11)} invalid artifact: ${error.message}`);
    }
}

if (check && maxWasmBytes === null && maxMemoryBytes === null) {
    console.log('\nNo MAX_WASM_BYTES or MAX_WASM_MEMORY_BYTES configured; size checks are report-only.');
}
if (failed) process.exitCode = 1;
