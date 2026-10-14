import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ bundle: vi.fn(), select: vi.fn(), render: vi.fn(), seconds: 15 }));
vi.mock('@remotion/bundler', () => ({ bundle: mocks.bundle }));
vi.mock('@remotion/renderer', () => ({ selectComposition: mocks.select, renderMedia: mocks.render }));
vi.mock('fluent-ffmpeg', () => ({ default: () => {
  const command = { setFfprobePath: () => command, input: () => command,
    ffprobe: (callback: (error: null, data: { format: { duration: number } }) => void) => callback(null, { format: { duration: mocks.seconds } }) };
  return command;
} }));
import { renderVideo } from '../src/render';
import { loadSettings } from '../src/runtime';
import { defaultVideoProps } from '../remotion/Root';
let directory: string;
let browser: string;
beforeEach(async () => {
  vi.resetAllMocks(); mocks.seconds = 15;
  directory = await mkdtemp(path.join(os.tmpdir(), 'render-test-'));
  browser = path.join(directory, 'chrome');
  for (const file of ['chrome', 'avatar.mp4', 'voice.wav', 'music.wav']) await writeFile(path.join(directory, file), 'mock');
  mocks.bundle.mockImplementation(() => mkdtemp(path.join(os.tmpdir(), 'bundle-test-')));
  mocks.select.mockResolvedValue({ id: 'AdVideo', durationInFrames: 450 });
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
describe('local-only render orchestration', () => {
  it('stages media, passes the local browser, and renders H.264 without real rendering', async () => {
    const result = await renderVideo(defaultVideoProps, loadSettings({ BROWSER_EXECUTABLE: browser }), directory);
    expect(result).toMatch(/ad-.*\.mp4$/);
    expect(mocks.bundle.mock.calls[0][0].publicDir).toContain('.render-');
    expect(mocks.select.mock.calls[0][0].browserExecutable).toBe(browser);
    expect(mocks.render).toHaveBeenCalledWith(expect.objectContaining({ codec: 'h264', pixelFormat: 'yuv420p', browserExecutable: browser }));
    expect((await readdir(directory)).some((name) => name.startsWith('.render-'))).toBe(false);
  });
  it('rejects mismatched media duration before bundling', async () => {
    mocks.seconds = 3;
    await expect(renderVideo(defaultVideoProps, loadSettings({ BROWSER_EXECUTABLE: browser }), directory)).rejects.toThrow('مدة');
    expect(mocks.bundle).not.toHaveBeenCalled();
  });
  it('never downloads a browser when the configured executable is missing', async () => {
    await expect(renderVideo(defaultVideoProps, loadSettings({ BROWSER_EXECUTABLE: '/missing-chrome' }), directory)).rejects.toThrow('ملف');
    expect(mocks.bundle).not.toHaveBeenCalled();
  });
  it('cleans staging and propagates rendering failure', async () => {
    mocks.render.mockRejectedValue(new Error('render error'));
    await expect(renderVideo(defaultVideoProps, loadSettings({ BROWSER_EXECUTABLE: browser }), directory)).rejects.toThrow('render error');
    expect((await readdir(directory)).some((name) => name.startsWith('.render-'))).toBe(false);
  });
});
