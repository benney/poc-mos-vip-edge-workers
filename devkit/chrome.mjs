// Locates a Chrome/Chromium binary for the headless test drivers.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CANDIDATES = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

export function findChrome() {
    for (const path of CANDIDATES) {
        if (existsSync(path)) return path;
    }
    for (const name of ['google-chrome', 'chromium', 'chrome']) {
        try {
            const found = execFileSync('which', [name], { encoding: 'utf8' }).trim();
            if (found) return found;
        } catch { /* not on PATH */ }
    }
    throw new Error(
        'No Chrome/Chromium found. Set CHROME_PATH to your browser binary '
        + '(these tests drive a real browser over CDP).',
    );
}
