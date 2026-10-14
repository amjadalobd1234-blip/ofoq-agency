import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ voice: vi.fn(), avatar: vi.fn(), music: vi.fn(), render: vi.fn(), preflight: vi.fn() }));
vi.mock('../src/voice', () => ({ generateVoice: mocks.voice }));
vi.mock('../src/avatar', () => ({ generateAvatar: mocks.avatar }));
vi.mock('../src/music', () => ({ generateMusic: mocks.music }));
vi.mock('../src/render', () => ({ renderVideo: mocks.render }));
vi.mock('../src/preflight', () => ({ preflight: mocks.preflight }));
import { generateAd } from '../src/pipeline';
import { loadSettings } from '../src/runtime';
let output: string;
beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  output = await mkdtemp(path.join(os.tmpdir(), 'video-test-'));
  mocks.render.mockResolvedValue('/mock/final.mp4');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(output, { recursive: true, force: true }); });
describe('five-stage local pipeline (mocked heavy operations)', () => {
  it('runs voice → avatar → music → composition with shared script/duration', async () => {
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/chrome', OUTPUT_DIR: output });
    expect(await generateAd('فيديو لعطر ذهبي، 30 ثانية', 'perfume', settings)).toBe('/mock/final.mp4');
    const voiceOrder = mocks.voice.mock.invocationCallOrder[0];
    expect(mocks.preflight.mock.invocationCallOrder[0]).toBeLessThan(voiceOrder);
    expect(voiceOrder).toBeLessThan(mocks.avatar.mock.invocationCallOrder[0]);
    expect(mocks.avatar.mock.invocationCallOrder[0]).toBeLessThan(mocks.music.mock.invocationCallOrder[0]);
    expect(mocks.music.mock.invocationCallOrder[0]).toBeLessThan(mocks.render.mock.invocationCallOrder[0]);
    const [run] = await readdir(output);
    const script = JSON.parse(await readFile(path.join(output, run, 'script.json'), 'utf8'));
    expect(script.duration).toBe(30);
    expect(mocks.render.mock.calls[0][0]).toMatchObject({ duration: 30, script, media: { voice: 'voice.wav', avatar: 'avatar.mp4', music: 'music.wav' } });
  });
  it('stops on missing local prerequisites without creating output media', async () => {
    mocks.preflight.mockRejectedValue(new Error('missing models'));
    await expect(generateAd('إعلان', 'services', loadSettings({ BROWSER_EXECUTABLE: '/chrome', OUTPUT_DIR: output }))).rejects.toThrow('missing models');
    expect(mocks.voice).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it('propagates stage failures instead of returning false success', async () => {
    mocks.avatar.mockRejectedValue(new Error('no face detected'));
    await expect(generateAd('إعلان', 'services', loadSettings({ BROWSER_EXECUTABLE: '/chrome', OUTPUT_DIR: output }))).rejects.toThrow('no face');
    expect(mocks.music).not.toHaveBeenCalled();
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
