import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeDuration, sceneFrames, videoConfigSchema } from '../src/config';
import { parseDuration, generateScript } from '../src/script';
import { loadSettings, toolRoot } from '../src/runtime';
import { buildVoiceCommand } from '../src/voice';
import { buildAvatarCommand } from '../src/avatar';
import { buildMusicCommand } from '../src/music';
import { calculateAdMetadata, defaultVideoProps, RemotionRoot } from '../remotion/Root';
import { AdVideo } from '../remotion/templates/AdVideo';
import type { ReactElement } from 'react';

const state = vi.hoisted(() => ({ frame: 0, durationInFrames: 450 }));
vi.mock('remotion', async (importOriginal) => ({
  ...await importOriginal<typeof import('remotion')>(),
  useCurrentFrame: () => state.frame,
  useVideoConfig: () => ({ durationInFrames: state.durationInFrames, fps: 30, width: 1080 }),
}));
const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium' });
beforeEach(() => { state.frame = 0; state.durationInFrames = 450; });

describe('independent local package', () => {
  it('declares dependencies and excludes hosted API clients', () => {
    const pkg = JSON.parse(readFileSync(path.join(toolRoot, 'package.json'), 'utf8'));
    for (const name of ['remotion', '@remotion/cli', '@remotion/bundler', '@remotion/renderer',
      'fluent-ffmpeg', 'dotenv', 'tsx', 'typescript', 'zod',
      // puppeteer-core drives the system Chromium; the full puppeteer package downloads one.
      'puppeteer-core']) expect(pkg.dependencies[name]).toBeTruthy();
    for (const name of ['groq-sdk', 'openai', 'edge-tts', 'puppeteer']) expect(pkg.dependencies[name]).toBeUndefined();
    for (const name of ['@remotion/cli', '@remotion/bundler', '@remotion/renderer']) {
      expect(pkg.dependencies[name]).toBe(pkg.dependencies.remotion);
    }
    expect(pkg.scripts.start).toBe('tsx src/index.ts');
    expect(pkg.scripts.build).toBe('tsc');
  });
  it('ignores outputs, models, portraits, virtual environments, and secrets', () => {
    const ignore = readFileSync(path.join(toolRoot, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['output/', '.env', '*.mp4', '*.wav', 'models/', 'vendor/', '.venv*/', 'assets/avatars/*', 'assets/avatars/*.png']));
    const env = readFileSync(path.join(toolRoot, '.env.example'), 'utf8');
    expect(env).not.toContain('API_KEY');
    expect(env).toContain('TTS_ENGINE=piper');
    expect(env).toContain('SADTALKER_DIR=/content/SadTalker');
    expect(env).toContain('AVATAR_MODE=sadtalker');
  });
  it('leaves the browser path empty for auto-detection and matches voice language', () => {
    // An empty value lets src/browser.ts detect Chromium instead of failing at startup.
    expect(loadSettings({}).BROWSER_EXECUTABLE).toBe('');
    expect(loadSettings({ BROWSER_EXECUTABLE: '/chrome' }).BROWSER_EXECUTABLE).toBe('/chrome');
    expect(() => loadSettings({ BROWSER_EXECUTABLE: '/chrome', TEMPLATE_LANG: 'en' })).toThrow('TTS_VOICE');
    expect(loadSettings({ BROWSER_EXECUTABLE: '/chrome', TEMPLATE_LANG: 'en', TTS_VOICE: 'en_US-lessac-medium' }).TEMPLATE_LANG).toBe('en');
  });
  it('rejects invalid environment settings instead of silently changing engines', () => {
    expect(() => loadSettings({ BROWSER_EXECUTABLE: '/chrome', TTS_ENGINE: 'cloud' })).toThrow();
    expect(() => loadSettings({ BROWSER_EXECUTABLE: '/chrome', WIDTH: '1081' })).toThrow();
    expect(() => loadSettings({ BROWSER_EXECUTABLE: '/chrome', TTS_RATE: 'bad' })).toThrow();
  });
});

describe('template engine, no AI', () => {
  it.each(['perfume', 'restaurant', 'clothing', 'services'] as const)('generates %s in both languages', (category) => {
    for (const lang of ['ar', 'en'] as const) {
      const script = generateScript(lang === 'ar' ? 'فيديو للمنتج، 30 ثانية' : 'Product ad, 30 seconds', category, { lang });
      expect(script).toMatchObject({ category, lang, duration: 30 });
      for (const field of ['hook', 'body', 'cta'] as const) {
        expect(script[field].length).toBeGreaterThan(0);
        expect(script[field]).not.toMatch(/\{\w+\}/);
      }
    }
  });
  it('uses user fields without inventing a price and is deterministic', () => {
    const script = generateScript('فيديو لعطر ذهبي فاخر', 'perfume');
    expect(script.hook).toBe('عطرك يحكي عنك قبل ما تتكلم');
    expect(script.body).toContain('عطر ذهبي فاخر');
    expect(script.cta).toBe('احصل عليه اليوم');
    expect(generateScript('فيديو لعطر ذهبي فاخر', 'perfume')).toEqual(script);
    const custom = generateScript('فيديو لعطر، 30 ثانية', 'perfume', { productName: 'ذهب', benefit: 'لمستك الخاصة', price: '25 ألف دينار' });
    expect(custom.body).toBe('ذهب — لمستك الخاصة');
    expect(custom.cta).toContain('25 ألف دينار');
  });
  it('uses a quoted product name and shorter copy for short ads', () => {
    expect(generateScript('إعلان لعطر "ذهب"، 15 ثانية', 'perfume').productName).toBe('ذهب');
    const short = generateScript('فيديو لعطر، 5 ثواني', 'perfume');
    expect(short.hook).toBe('تميّز');
    expect(short.cta).toBe('اطلبه');
  });
  it('rejects empty or oversized descriptions', () => {
    expect(() => generateScript(' ', 'perfume')).toThrow();
    expect(() => generateScript('x'.repeat(501), 'perfume')).toThrow();
  });
});

describe('duration rules', () => {
  it.each([
    ['فيديو إعلاني', 15], ['عطر 100 مل بسعر 30 دولار', 15], ['فيديو 30 ثانية لمطعم', 30],
    ['٣٠ ثانية', 30], ['۳۰ ثانية', 30], ['2 ثانية', 5], ['0 seconds', 5], ['-2 seconds', 5],
    ['90 ثانية', 60], ['12.7 seconds', 13], ['1 minute', 60], ['نصف دقيقة', 30], ['ربع دقيقة', 15],
    ['ثلاثين ثانية', 30], ['ثانيتين', 5], ['دقيقة', 60], ['دقيقتين', 60],
  ])('parses %s as %s', (text, seconds) => expect(parseDuration(text)).toBe(seconds));
  it.each([[undefined, 15], [null, 15], [NaN, 15], [Infinity, 15], ['30', 15], [0, 5], [3, 5], [30, 30], [61, 60], [29.7, 30]])(
    'clamps %s to %s', (value, expected) => expect(normalizeDuration(value)).toBe(expected),
  );
});

describe('safe local command builders', () => {
  it('builds the Piper wrapper arguments with rate/model/timing', () => {
    const command = buildVoiceCommand(settings, '/tmp/script with spaces.json', '/tmp/voice.wav');
    expect(command.executable).toBe('python3');
    expect(command.args).toEqual([
      path.join(toolRoot, 'python/tts_generate.py'), '--script', '/tmp/script with spaces.json',
      '--model', path.join(toolRoot, 'models/piper/ar_JO-kareem-medium.onnx'),
      '--rate', '1', '--fps', '30', '--ffmpeg', 'ffmpeg', '--output', '/tmp/voice.wav',
    ]);
  });
  it('passes portrait, audio, result directory, and device separately to SadTalker', () => {
    const command = buildAvatarCommand({ ...settings, DEFAULT_AVATAR: 'assets/avatars/a; touch nope.png', AVATAR_DEVICE: 'cuda' }, '/tmp/voice.wav', '/tmp/results');
    expect(command.executable).toBe(path.join(toolRoot, '.venv-sadtalker/bin/python'));
    expect(command.args).toContain(path.join(toolRoot, 'assets/avatars/a; touch nope.png'));
    expect(command.args).toContain('--driven_audio');
    expect(command.args).toContain('cuda');
    expect(command.args).not.toContain('--cpu');
  });
  it('builds deterministic music arguments with clamped duration', () => {
    expect(buildMusicCommand(settings, 90, '/tmp/music.wav').args).toEqual([
      path.join(toolRoot, 'python/music_generate.py'), '--duration', '60', '--output', '/tmp/music.wav',
    ]);
  });
});

describe('Remotion metadata and local media', () => {
  it('registers a 1080 square 30fps composition', () => {
    expect(RemotionRoot().props).toMatchObject({ id: 'AdVideo', component: AdVideo, durationInFrames: 450, fps: 30, width: 1080, height: 1080 });
  });
  it.each([[5, 150], [15, 450], [30, 900], [60, 1800], [90, 1800], [0, 150]])('uses %s seconds as %s frames', async (duration, frames) => {
    expect(await calculateAdMetadata({ props: { ...defaultVideoProps, duration }, defaultProps: defaultVideoProps,
      abortSignal: new AbortController().signal, compositionId: 'AdVideo', isRendering: true,
    })).toMatchObject({ durationInFrames: frames, fps: 30, width: 1080, height: 1080 });
  });
  it('honors configured dimensions and fps', async () => {
    expect(await calculateAdMetadata({ props: { ...defaultVideoProps, fps: 60, width: 720, height: 1280 }, defaultProps: defaultVideoProps,
      abortSignal: new AbortController().signal, compositionId: 'AdVideo', isRendering: true,
    })).toMatchObject({ durationInFrames: 900, fps: 60, width: 720, height: 1280 });
  });
  it('uses the same 15/75/95 percent boundaries for speech and video', () => {
    expect(sceneFrames(30, 30)).toEqual({ total: 900, bodyStart: 135, ctaStart: 675, speechEnd: 855 });
  });
  it.each(['https://example.com/avatar.mp4', '../avatar.mp4', 'file:///voice.wav'])('rejects non-local staged media: %s', (avatar) => {
    expect(() => videoConfigSchema.parse({ ...defaultVideoProps, media: { logo: 'logo.svg', avatar } })).toThrow();
  });
  it('ends with black and renders two separate audio tracks', () => {
    state.frame = 449;
    const tree = AdVideo({ ...defaultVideoProps, media: { logo: 'logo.svg', avatar: 'avatar.mp4', voice: 'voice.wav', music: 'music.wav' } });
    // JSX can be inspected without starting Chrome or running a render.
    const children = tree.props.children as ReactElement<{ style?: { opacity: number }; volume?: number | ((frame: number) => number) }>[];
    expect(children[1].props.style?.opacity).toBe(0);
    expect(children[2].props.volume).toBe(.9);
    expect((children[3].props.volume as (frame: number) => number)(449)).toBe(0);
  });
});
