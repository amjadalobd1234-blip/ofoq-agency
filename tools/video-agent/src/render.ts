import path from 'node:path';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import ffmpeg from 'fluent-ffmpeg';
import { videoConfigSchema, type VideoConfig } from './config';
import { localPath, toolRoot, type Settings } from './runtime';
import { requireFile } from './process';

export function probeDuration(filename: string, ffprobePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg().setFfprobePath(ffprobePath).input(filename).ffprobe((error, data) => {
      if (error) return reject(error);
      const seconds = Number(data.format.duration);
      if (!Number.isFinite(seconds) || seconds <= 0) return reject(new Error(`Invalid media duration: ${filename}`));
      resolve(seconds);
    });
  });
}

export async function renderVideo(config: VideoConfig, settings: Settings, runDirectory: string): Promise<string> {
  const inputProps = videoConfigSchema.parse(config);
  // Explicit browser path prevents Remotion downloading Chrome during a run.
  const browserExecutable = localPath(settings.BROWSER_EXECUTABLE);
  await requireFile(browserExecutable);
  for (const file of ['avatar.mp4', 'voice.wav', 'music.wav']) {
    const filename = path.join(runDirectory, file);
    await requireFile(filename);
    const seconds = await probeDuration(filename, settings.FFPROBE_PATH);
    if (Math.abs(seconds - inputProps.duration) > 0.25) {
      throw new Error(`مدة ${file} لا تطابق مدة الإعلان (${seconds}s).`);
    }
  }
  const staging = await mkdtemp(path.join(runDirectory, '.render-'));
  let serveUrl: string | undefined;
  const outputLocation = path.join(runDirectory, `ad-${path.basename(runDirectory)}.mp4`);
  try {
    const publicDir = path.join(staging, 'public');
    await mkdir(publicDir);
    for (const file of ['avatar.mp4', 'voice.wav', 'music.wav']) {
      await copyFile(path.join(runDirectory, file), path.join(publicDir, file));
    }
    await copyFile(localPath('assets/logo.svg'), path.join(publicDir, 'logo.svg'));
    if (settings.FONT_FILE) await copyFile(localPath(settings.FONT_FILE), path.join(publicDir, 'font.woff2'));
    serveUrl = await bundle({ entryPoint: localPath('remotion/index.tsx'), rootDir: toolRoot, publicDir });
    const composition = await selectComposition({ serveUrl, id: 'AdVideo', inputProps, browserExecutable });
    await renderMedia({ composition, serveUrl, inputProps, browserExecutable,
      codec: 'h264', pixelFormat: 'yuv420p', outputLocation, concurrency: 2 });
    return outputLocation;
  } catch (error) {
    await rm(outputLocation, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (serveUrl) await rm(serveUrl, { recursive: true, force: true });
  }
}
