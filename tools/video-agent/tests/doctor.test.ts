import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ runCommand: vi.fn(), close: vi.fn(), version: vi.fn(), launch: vi.fn() }));
vi.mock('../src/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/process')>(),
  runCommand: mocks.runCommand,
}));
import { doctor, inspectBrowser } from '../src/doctor';
import { loadSettings } from '../src/runtime';

let directory: string;
let browser: string;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), 'doctor-test-'));
  browser = path.join(directory, 'chromium');
  await writeFile(browser, '#!/bin/sh\nexit 0\n');
  mocks.version.mockResolvedValue('Chrome/131.0.0.0');
  mocks.launch.mockResolvedValue({ version: mocks.version, close: mocks.close });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe('browser doctor', () => {
  it('launches the detected system browser once and reports its version', async () => {
    const settings = loadSettings({ BROWSER_EXECUTABLE: browser });
    await expect(inspectBrowser(settings, mocks.launch)).resolves.toEqual({ executable: browser, version: 'Chrome/131.0.0.0' });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.launch.mock.calls[0][0]).toBe(browser);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('finds the browser on its own when no path is configured', async () => {
    vi.stubEnv('BROWSER_EXECUTABLE', browser);
    await expect(inspectBrowser(loadSettings({}), mocks.launch)).resolves.toMatchObject({ executable: browser });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
  it('closes the browser even when the version probe fails', async () => {
    mocks.version.mockRejectedValue(new Error('protocol error'));
    await expect(inspectBrowser(loadSettings({ BROWSER_EXECUTABLE: browser }), mocks.launch)).rejects.toThrow('protocol error');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('reports a missing browser without launching anything', async () => {
    await expect(inspectBrowser(loadSettings({ BROWSER_EXECUTABLE: '/missing/chrome' }), mocks.launch)).rejects.toThrow('غير موجود');
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('checks ffmpeg and ffprobe before printing the browser', async () => {
    vi.stubEnv('BROWSER_EXECUTABLE', browser);
    vi.stubEnv('FFMPEG_PATH', 'ffmpeg');
    vi.stubEnv('FFPROBE_PATH', 'ffprobe');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    await doctor(mocks.launch);
    expect(mocks.runCommand.mock.calls.map(([command]) => command.executable)).toEqual(['ffmpeg', 'ffprobe']);
    expect(logs.some((line) => line.includes(browser) && line.includes('Chrome/131.0.0.0'))).toBe(true);
  });
});
