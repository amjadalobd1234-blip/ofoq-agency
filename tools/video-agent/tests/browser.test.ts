import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_SEARCH_PATHS, INSTALL_HINT, browserCandidates, browserEnv,
  browserFileExists, resolveBrowserExecutable,
} from '../src/browser';
import { loadSettings, localPath } from '../src/runtime';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'browser-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const existing = (files: string[]) => async (candidate: string) => files.includes(candidate);

describe('chromium detection', () => {
  it('prefers PUPPETEER_EXECUTABLE_PATH when it is set', async () => {
    const browser = path.join(directory, 'puppeteer-chrome');
    const settings = loadSettings({ BROWSER_EXECUTABLE: path.join(directory, 'settings-chrome') });
    const result = await resolveBrowserExecutable(
      { ...browserEnv(settings), PUPPETEER_EXECUTABLE_PATH: browser },
      existing([browser]),
    );
    expect(result).toBe(browser);
  });
  it('falls back to BROWSER_EXECUTABLE when puppeteer is unset', async () => {
    const browser = path.join(directory, 'settings-chrome');
    const settings = loadSettings({ BROWSER_EXECUTABLE: browser });
    expect(await resolveBrowserExecutable(browserEnv(settings, {}), existing([browser]))).toBe(browser);
  });
  it.each([...BROWSER_SEARCH_PATHS])('detects the system browser at %s when nothing is configured', async (found) => {
    const settings = loadSettings({});
    expect(settings.BROWSER_EXECUTABLE).toBe('');
    expect(await resolveBrowserExecutable(browserEnv(settings, {}), existing([found]))).toBe(found);
  });
  it('resolves a relative configured path against the tool directory', async () => {
    // No real file is needed: the injected existence check receives the resolved path.
    const seen: string[] = [];
    const settings = loadSettings({ BROWSER_EXECUTABLE: 'vendor/chrome' });
    await resolveBrowserExecutable(browserEnv(settings, {}), async (candidate) => {
      seen.push(candidate);
      return true;
    });
    expect(seen[0]).toBe(localPath('vendor/chrome'));
    expect(path.isAbsolute(seen[0])).toBe(true);
  });
  it('detects a real executable file on disk and rejects a missing one', async () => {
    const browser = path.join(directory, 'chromium');
    await writeFile(browser, '#!/bin/sh\nexit 0\n');
    await chmod(browser, 0o755);
    expect(await browserFileExists(browser)).toBe(true);
    expect(await browserFileExists(path.join(directory, 'absent'))).toBe(false);
    expect(await browserFileExists(directory)).toBe(false);
  });
  it('lists explicit environment variables before the system search paths', () => {
    const candidates = browserCandidates({ PUPPETEER_EXECUTABLE_PATH: '/a', BROWSER_EXECUTABLE: '/b' });
    expect(candidates.map((candidate) => candidate.value)).toEqual(['/a', '/b', ...BROWSER_SEARCH_PATHS]);
    expect(candidates.filter((candidate) => candidate.explicit)).toHaveLength(2);
    expect(browserCandidates({ BROWSER_EXECUTABLE: '   ' })).toHaveLength(BROWSER_SEARCH_PATHS.length);
  });
});

describe('actionable browser errors', () => {
  it('explains a configured path that does not exist instead of downloading a browser', async () => {
    const missing = '/missing/chrome';
    const settings = loadSettings({ BROWSER_EXECUTABLE: missing });
    await expect(resolveBrowserExecutable(browserEnv(settings, {}), existing([]))).rejects.toThrow(
      new RegExp(`${missing.replace(/\//g, '\\/')}`),
    );
    await expect(resolveBrowserExecutable(browserEnv(settings, {}), existing([]))).rejects.toThrow(/BROWSER_EXECUTABLE/);
    await expect(resolveBrowserExecutable(browserEnv(settings, {}), existing([]))).rejects.toThrow(/لن تنزّل الأداة أي متصفح/);
  });
  it('names the missing variable and suggests detected browsers', async () => {
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/missing/chrome' });
    const error = await resolveBrowserExecutable({ ...browserEnv(settings), PUPPETEER_EXECUTABLE_PATH: '/missing/chrome' },
      existing(['/usr/bin/google-chrome'])).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('PUPPETEER_EXECUTABLE_PATH');
    expect((error as Error).message).toContain('/usr/bin/google-chrome');
  });
  it('lists every checked path when no browser is installed', async () => {
    const settings = loadSettings({});
    const error = await resolveBrowserExecutable(browserEnv(settings, {}), existing([])).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('لم يتم العثور على Chrome/Chromium');
    for (const candidate of BROWSER_SEARCH_PATHS) expect(message).toContain(candidate);
    expect(message).toContain('apt-get install -y chromium-browser');
    expect(message).toContain('BROWSER_EXECUTABLE=');
  });
  it('never reports success when existence checks fail everywhere', async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const settings = loadSettings({ BROWSER_EXECUTABLE: path.join(directory, 'chrome') });
    await expect(resolveBrowserExecutable(browserEnv(settings, {}), exists)).rejects.toThrow(INSTALL_HINT);
    expect(exists).toHaveBeenCalled();
  });
});
