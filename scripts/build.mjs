// Compiles a worker to wasm.
//   node scripts/build.mjs [worker] [--test]
// Defaults to `mos-proxy`; WORKER=hello (or EXAMPLE=hello) also works.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, findWorker, workerFrom } from './paths.mjs';

const isTest = process.argv.includes('--test');
const { name, dir: worker } = findWorker(workerFrom(process.argv));
const entry = resolve(ROOT, worker, `assembly/${isTest ? 'test' : 'index'}.ts`);
const outDir = resolve(ROOT, 'build', name);
const out = resolve(outDir, isTest ? 'test.wasm' : 'release.wasm');

if (!existsSync(entry)) {
    console.error(`no such entry: ${worker}/assembly/${isTest ? 'test' : 'index'}.ts`);
    process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const nodeModules = resolve(ROOT, 'node_modules');
// asc chokes on an inherited --experimental NODE_OPTIONS.
const { NODE_OPTIONS: _drop, ...env } = process.env;

const args = [
    entry,
    '--outFile', out,
    // A bump allocator with no GC: each request starts from a clean heap.
    '--runtime', 'stub',
    '--transform', 'json-as',
    '--path', nodeModules,
];
if (isTest) args.push('--optimizeLevel', '0');
else args.push('--optimizeLevel', '3', '--shrinkLevel', '2', '--textFile', resolve(outDir, 'release.wat'));

execFileSync(resolve(nodeModules, '.bin/asc'), args, { cwd: nodeModules, env, stdio: 'inherit' });
console.log(`built build/${name}/${isTest ? 'test' : 'release'}.wasm`);
