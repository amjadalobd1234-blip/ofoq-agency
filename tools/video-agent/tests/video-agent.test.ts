import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  groq: vi.fn(),
  bundle: vi.fn(),
  selectComposition: vi.fn(),
  renderMedia: vi.fn(),
  mkdir: vi.fn(),
  frame: 0,
  durationInFrames: 450,
}));

vi.mock('groq-sdk', () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
    constructor(options: unknown) { mocks.groq(options); }
  },
}));
vi.mock('@remotion/bundler', () => ({ bundle: mocks.bundle }));
vi.mock('@remotion/renderer', () => ({
  selectComposition: mocks.selectComposition,
  renderMedia: mocks.renderMedia,
}));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }));
vi.mock('remotion', async (importOriginal) => ({
  ...await importOriginal<typeof import('remotion')>(),
  useCurrentFrame: () => mocks.frame,
  useVideoConfig: () => ({ durationInFrames: mocks.durationInFrames }),
}));

import { generateVideoConfig } from '../src/groq';
import { normalizeDuration, validateVideoConfig, type VideoConfig } from '../src/config';
import { renderVideo } from '../src/render';
import { calculateAdMetadata, defaultVideoProps, RemotionRoot } from '../remotion/Root';
import { AdVideo } from '../remotion/templates/AdVideo';

const toolRoot = fileURLToPath(new URL('../', import.meta.url));
const valid: VideoConfig = {
  duration: 30,
  title: 'عطر الفخامة',
  subtitle: 'أناقة ذهبية تترك أثرًا لا يُنسى',
  backgroundColor: '#000000',
  textColor: '#FFFFFF',
  accentColor: '#D4AF37',
};

function reply(value: unknown) {
  mocks.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(value) } }] });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GROQ_API_KEY', 'test-key-not-real');
  mocks.frame = 0;
  mocks.durationInFrames = 450;
  mocks.bundle.mockResolvedValue('/mock/bundle');
  mocks.selectComposition.mockResolvedValue({ id: 'AdVideo', durationInFrames: 900 });
  mocks.renderMedia.mockResolvedValue(undefined);
  mocks.mkdir.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('standalone package', () => {
  it('declares the required dependencies, scripts, and matching Remotion versions', () => {
    const pkg = JSON.parse(readFileSync(path.join(toolRoot, 'package.json'), 'utf8'));
    for (const dependency of [
      'remotion', '@remotion/cli', '@remotion/bundler', '@remotion/renderer',
      'groq-sdk', 'dotenv', 'tsx', 'typescript', 'react', 'react-dom',
    ]) {
      expect(pkg.dependencies[dependency]).toBeTruthy();
    }
    for (const dependency of ['@remotion/cli', '@remotion/bundler', '@remotion/renderer']) {
      expect(pkg.dependencies[dependency]).toBe(pkg.dependencies.remotion);
    }
    expect(pkg.scripts.start).toBe('tsx src/index.ts');
    expect(pkg.scripts.build).toBe('tsc');
    expect(pkg.engines.node).toBe('>=18.0.0');
  });

  it('ignores outputs and secrets and supplies an environment example', () => {
    const ignore = readFileSync(path.join(toolRoot, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['output/', '.env', '*.mp4', 'node_modules/']));
    expect(readFileSync(path.join(toolRoot, '.env.example'), 'utf8')).toContain('GROQ_API_KEY=your_key_here');
  });

  it('fails gracefully from the CLI with a missing API key (no network or render)', () => {
    const result = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
      cwd: toolRoot,
      env: { ...process.env, GROQ_API_KEY: '' },
      input: 'فيديو إعلاني\n',
      encoding: 'utf8',
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('اكتب وصف الفيديو:');
    expect(result.stderr).toContain('GROQ_API_KEY');
    expect(result.stdout).not.toContain('الفيديو جاهز:');
  });
});

describe('Groq integration (mocked)', () => {
  it('uses the environment key, JSON mode, model, Arabic description, and duration rules', async () => {
    reply(valid);
    const description = 'فيديو إعلاني لعطر ذهبي وأسود، 30 ثانية';
    expect(await generateVideoConfig(description)).toEqual(valid);
    expect(mocks.groq).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'test-key-not-real' }));
    const request = mocks.create.mock.calls[0][0];
    expect(request.model).toBe('llama-3.3-70b-versatile');
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.messages[1]).toEqual({ role: 'user', content: description });
    expect(request.messages[0].content).toContain('duration = 15');
    expect(request.messages[0].content).toContain('5 و60');
  });

  it.each([[2, 5], [90, 60], [29.6, 30], [0, 5]])('clamps API duration %s to %s', async (input, expected) => {
    reply({ ...valid, duration: input });
    expect((await generateVideoConfig(`فيديو مدته ${input} ثانية`)).duration).toBe(expected);
  });

  it('defaults to 15 seconds when the model omits duration', async () => {
    const { duration: _, ...withoutDuration } = valid;
    reply(withoutDuration);
    expect((await generateVideoConfig('فيديو إعلاني')).duration).toBe(15);
  });

  it('accepts the 15-second response for an unspecified duration', async () => {
    reply({ ...valid, duration: 15 });
    expect((await generateVideoConfig('فيديو إعلاني')).duration).toBe(15);
  });

  it.each(['', '   '])('rejects blank descriptions before calling Groq', async (input) => {
    await expect(generateVideoConfig(input)).rejects.toThrow('وصفًا');
    expect(mocks.groq).not.toHaveBeenCalled();
  });

  it.each(['', 'your_key_here'])('rejects missing/placeholder keys', async (key) => {
    vi.stubEnv('GROQ_API_KEY', key);
    await expect(generateVideoConfig('فيديو إعلاني')).rejects.toThrow('GROQ_API_KEY');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(['not json', '```json\n{}\n```'])('rejects malformed JSON: %s', async (content) => {
    mocks.create.mockResolvedValue({ choices: [{ message: { content } }] });
    await expect(generateVideoConfig('فيديو')).rejects.toThrow('JSON غير صالحة');
  });

  it('rejects an empty completion', async () => {
    mocks.create.mockResolvedValue({ choices: [] });
    await expect(generateVideoConfig('فيديو')).rejects.toThrow('لم يُرجع Groq');
  });

  it('propagates API failures', async () => {
    mocks.create.mockRejectedValue(new Error('rate limit'));
    await expect(generateVideoConfig('فيديو')).rejects.toThrow('rate limit');
  });
});

describe('configuration validation', () => {
  it.each([
    [undefined, 15], [null, 15], [NaN, 15], [Infinity, 15], ['30', 15],
    [-1, 5], [0, 5], [5, 5], [15, 15], [30, 30], [60, 60], [100, 60], [12.7, 13],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeDuration(input)).toBe(expected);
  });

  it.each([null, [], {}, { ...valid, title: 42 }, { ...valid, subtitle: '' },
    { ...valid, backgroundColor: 'red' }, { ...valid, textColor: '#12345g' },
    { ...valid, accentColor: 'url(remote)' }, { ...valid, title: 'x'.repeat(101) },
  ])('rejects invalid render props: %j', (input) => {
    expect(() => validateVideoConfig(input)).toThrow();
  });

  it('strips unknown fields instead of passing them to the renderer', () => {
    expect(validateVideoConfig({ ...valid, unwanted: true })).toEqual(valid);
  });
});

describe('Remotion configuration and animation (no browser)', () => {
  it('registers the square 30fps composition with a 450-frame default', () => {
    const root = RemotionRoot();
    expect(root.props).toMatchObject({
      id: 'AdVideo', component: AdVideo, durationInFrames: 450,
      fps: 30, width: 1080, height: 1080, defaultProps: defaultVideoProps,
      calculateMetadata: calculateAdMetadata,
    });
    expect(defaultVideoProps.duration).toBe(15);
    expect(readFileSync(path.join(toolRoot, 'remotion/index.tsx'), 'utf8')).toContain('registerRoot(RemotionRoot)');
  });

  it.each([[5, 150], [15, 450], [30, 900], [60, 1800], [100, 1800], [0, 150]])(
    'calculates duration %s as %s frames', async (duration, frames) => {
      const metadata = await calculateAdMetadata({
        props: { ...valid, duration }, defaultProps: defaultVideoProps,
        abortSignal: new AbortController().signal, compositionId: 'AdVideo', isRendering: true,
      });
      expect(metadata).toMatchObject({ durationInFrames: frames, fps: 30, width: 1080, height: 1080 });
    },
  );

  it.each([150, 450, 900, 1800])('scales all animation phases to %s frames', (frames) => {
    mocks.durationInFrames = frames;
    const at = (progress: number) => {
      mocks.frame = Math.round(progress * (frames - 1));
      const tree = AdVideo(valid);
      const background = tree.props.children;
      const [title, subtitle] = background.props.children;
      return { background, title, subtitle };
    };
    expect(at(0).background.props.style.opacity).toBe(0);
    expect(at(0).title.props.style.opacity).toBe(0);
    expect(at(0.1).background.props.style.opacity).toBe(1);
    expect(at(0.1).title.props.style.opacity).toBeGreaterThan(0);
    expect(at(0.1).title.props.style.opacity).toBeLessThan(1);
    expect(at(0.1).subtitle.props.style.opacity).toBe(0);
    expect(at(0.3).title.props.style.opacity).toBe(1);
    expect(at(0.3).subtitle.props.style.opacity).toBeGreaterThan(0);
    expect(at(0.3).subtitle.props.style.opacity).toBeLessThan(1);
    expect(at(0.6).background.props.style.opacity).toBe(1);
    expect(at(0.6).subtitle.props.style.opacity).toBe(1);
    expect(at(0.9).background.props.style.opacity).toBeGreaterThan(0);
    expect(at(0.9).background.props.style.opacity).toBeLessThan(1);
    expect(at(1).background.props.style.opacity).toBe(0);
  });

  it('uses only supplied title/subtitle and colors with RTL/system font styling', () => {
    const tree = AdVideo(valid);
    const background = tree.props.children;
    const [title, subtitle] = background.props.children as ReactElement<{ children: string; style: { color: string } }>[];
    expect(background.props.dir).toBe('rtl');
    expect(background.props.style.backgroundColor).toBe(valid.backgroundColor);
    expect(background.props.style.fontFamily).toContain('system-ui');
    expect(title.props.children).toBe(valid.title);
    expect(title.props.style.color).toBe(valid.textColor);
    expect(subtitle.props.children).toBe(valid.subtitle);
    expect(subtitle.props.style.color).toBe(valid.accentColor);
  });
});

describe('MP4 render orchestration (all expensive operations mocked)', () => {
  it('creates output/, selects with dynamic props, and writes timestamped H.264 MP4', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    const output = await renderVideo(valid);
    expect(mocks.mkdir).toHaveBeenCalledWith(path.join(toolRoot, 'output'), { recursive: true });
    expect(mocks.bundle).toHaveBeenCalledWith({
      entryPoint: path.join(toolRoot, 'remotion/index.tsx'), rootDir: toolRoot,
    });
    expect(mocks.selectComposition).toHaveBeenCalledWith({
      serveUrl: '/mock/bundle', id: 'AdVideo', inputProps: valid,
    });
    expect(output).toBe(path.join(toolRoot, 'output/video-1234567890.mp4'));
    expect(mocks.renderMedia).toHaveBeenCalledWith({
      composition: { id: 'AdVideo', durationInFrames: 900 },
      serveUrl: '/mock/bundle', inputProps: valid,
      codec: 'h264', pixelFormat: 'yuv420p', outputLocation: output,
    });
  });

  it('normalizes duration before selecting AND rendering', async () => {
    await renderVideo({ ...valid, duration: 100 });
    expect(mocks.selectComposition.mock.calls[0][0].inputProps.duration).toBe(60);
    expect(mocks.renderMedia.mock.calls[0][0].inputProps.duration).toBe(60);
  });

  it('rejects invalid props without bundling', async () => {
    await expect(renderVideo({ ...valid, title: '' })).rejects.toThrow();
    expect(mocks.bundle).not.toHaveBeenCalled();
  });

  it('propagates a failed render instead of reporting a ready video', async () => {
    mocks.renderMedia.mockRejectedValue(new Error('render failed'));
    await expect(renderVideo(valid)).rejects.toThrow('render failed');
  });
});
