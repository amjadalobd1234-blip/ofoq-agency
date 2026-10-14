import path from 'node:path';
import { stat } from 'node:fs/promises';
import { localPath } from './runtime';

// Explicit configuration first, then the paths a Linux/Colab image usually provides.
export const BROWSER_ENV_VARS = ['PUPPETEER_EXECUTABLE_PATH', 'BROWSER_EXECUTABLE'] as const;
export const BROWSER_SEARCH_PATHS = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
] as const;

export type BrowserExists = (candidate: string) => Promise<boolean>;

/** Same rule as process.requireFile: an existing, non-empty file. */
export const browserFileExists: BrowserExists = async (candidate) => {
  const info = await stat(candidate).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
};

export type BrowserCandidate = { value: string; source: string; explicit: boolean };

export function browserCandidates(env: NodeJS.ProcessEnv): BrowserCandidate[] {
  const explicit = BROWSER_ENV_VARS
    .filter((name) => (env[name] ?? '').trim().length > 0)
    .map((name) => ({ value: (env[name] as string).trim(), source: name, explicit: true }));
  // Relative paths follow the rest of the settings: resolved against the tool directory.
  const detected = BROWSER_SEARCH_PATHS.map((value) => ({ value, source: 'system path', explicit: false }));
  return [...explicit, ...detected];
}

export const INSTALL_HINT = [
  'ثبّت متصفح Chrome/Chromium محليًا أولًا:',
  '  Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y chromium-browser',
  '  Google Colab:  !apt-get install -y -qq chromium-browser',
  '  macOS:         brew install --cask google-chrome',
  'أو حدّد مسارًا موجودًا فعلًا:',
  '  BROWSER_EXECUTABLE=/usr/bin/chromium npm start',
  'لن تنزّل الأداة أي متصفح أثناء التشغيل.',
].join('\n');

const absolute = (value: string) => (path.isAbsolute(value) ? value : localPath(value));

async function availableBrowsers(exists: BrowserExists, exclude: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of BROWSER_SEARCH_PATHS) {
    if (candidate !== exclude && await exists(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Resolve the Chrome/Chromium executable used by Remotion.
 *
 * An explicitly configured path is authoritative: when it is missing the run fails
 * with an actionable message instead of silently falling back or downloading a browser.
 * When nothing is configured, the known system paths are scanned.
 */
export async function resolveBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
  exists: BrowserExists = browserFileExists,
): Promise<string> {
  const checked: string[] = [];
  for (const candidate of browserCandidates(env)) {
    const resolved = absolute(candidate.value);
    if (await exists(resolved)) return resolved;
    checked.push(resolved);
    if (candidate.explicit) {
      const available = await availableBrowsers(exists, resolved);
      throw new Error([
        `ملف المتصفح المضبوط في ${candidate.source} غير موجود: ${resolved}`,
        available.length > 0
          ? `متصفحات مكتشفة على هذا الجهاز: ${available.join('، ')}`
          : 'لم يُكتشف أي متصفح في المسارات المعروفة.',
        INSTALL_HINT,
      ].join('\n'));
    }
  }
  throw new Error([
    'لم يتم العثور على Chrome/Chromium مثبّت على هذا الجهاز.',
    `المسارات التي جرى فحصها: ${checked.join('، ')}`,
    INSTALL_HINT,
  ].join('\n'));
}

/**
 * Settings win over the process environment when a path is configured;
 * an empty value keeps the environment as-is so detection (including
 * PUPPETEER_EXECUTABLE_PATH) can still run.
 */
export function browserEnv(
  settings: { BROWSER_EXECUTABLE: string },
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return settings.BROWSER_EXECUTABLE ? { ...env, BROWSER_EXECUTABLE: settings.BROWSER_EXECUTABLE } : env;
}
