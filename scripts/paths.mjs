import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_WORKER = 'mos-proxy';

/** First non-flag argv entry, else $WORKER/$EXAMPLE, else the default. */
export function workerFrom(argv) {
    const positional = argv.slice(2).find((a) => !a.startsWith('-'));
    return positional ?? process.env.WORKER ?? process.env.EXAMPLE ?? DEFAULT_WORKER;
}

/**
 * A worker is any directory holding assembly/index.ts. Bare names resolve at the repo
 * root first, then under examples/, so `mos-proxy` and `hello` both work.
 */
export function workerDir(name) {
    for (const candidate of [name, `examples/${name}`]) {
        if (existsSync(resolve(ROOT, candidate, 'assembly/index.ts'))) return candidate;
    }
    return name;
}
