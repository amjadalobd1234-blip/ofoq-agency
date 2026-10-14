import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { browserEnv, resolveBrowserExecutable } from './browser';
import { requireFile, runCommand } from './process';
import { loadSettings, type Settings } from './runtime';

/** Minimal surface of a puppeteer Browser instance used by the doctor. */
export type LaunchedBrowser = { version: () => Promise<string>; close: () => Promise<void> };
export type BrowserLauncher = (executablePath: string) => Promise<LaunchedBrowser>;

// puppeteer-core never downloads a browser: it only drives the executable we resolve.
async function launchWithPuppeteer(executablePath: string): Promise<LaunchedBrowser> {
  const { default: puppeteer } = await import('puppeteer-core');
  return puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
}

export async function inspectBrowser(
  settings: Settings,
  launch: BrowserLauncher = launchWithPuppeteer,
): Promise<{ executable: string; version: string }> {
  const executable = await resolveBrowserExecutable(browserEnv(settings));
  await requireFile(executable);
  const browser = await launch(executable);
  try {
    return { executable, version: await browser.version() };
  } finally {
    await browser.close();
  }
}

export async function doctor(launch: BrowserLauncher = launchWithPuppeteer) {
  const settings = loadSettings();
  console.log(`ffmpeg:  ${settings.FFMPEG_PATH}`);
  console.log(`ffprobe: ${settings.FFPROBE_PATH}`);
  for (const executable of [settings.FFMPEG_PATH, settings.FFPROBE_PATH]) {
    await runCommand({ executable, args: ['-version'], timeoutMs: 10_000 });
  }
  const { executable, version } = await inspectBrowser(settings, launch);
  console.log(`✅ المتصفح: ${executable} (${version})`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  doctor().catch((error: unknown) => {
    console.error('خطأ:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
