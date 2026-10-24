import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The repo's own worker lives at the root; the rest are named directories under these groups. */
const DEFAULT_WORKER = 'mos-proxy';
const GROUPS = ['examples', 'test', 'tools'];

/** First non-flag argv entry, else $WORKER/$EXAMPLE, else the default. */
export function workerFrom(argv) {
    const positional = argv.slice(2).find((a) => !a.startsWith('-'));
    return positional ?? process.env.WORKER ?? process.env.EXAMPLE ?? DEFAULT_WORKER;
}

/** Every directory holding assembly/index.ts, as `{ name, dir }` (dir is relative to ROOT). */
export function listWorkers() {
    const found = [];
    if (existsSync(resolve(ROOT, 'assembly/index.ts'))) found.push({ name: DEFAULT_WORKER, dir: '.' });
    for (const group of GROUPS) {
        const base = resolve(ROOT, group);
        if (!existsSync(base)) continue;
        for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory() && existsSync(resolve(base, entry.name, 'assembly/index.ts'))) {
                found.push({ name: entry.name, dir: `${group}/${entry.name}` });
            }
        }
    }
    return found;
}

export function findWorker(name) {
    const worker = listWorkers().find((w) => w.name === name);
    if (!worker) {
        console.error(`no such worker: ${name} (have ${listWorkers().map((w) => w.name).join(', ')})`);
        process.exit(1);
    }
    return worker;
}

/** Playground scenarios: beside the worker, except the root worker's, which sit in playground/. */
export const presetsFor = ({ dir }) => resolve(ROOT, dir === '.' ? 'playground' : dir, 'presets.mjs');
