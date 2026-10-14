import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { validateVideoConfig, type VideoConfig } from './config';

// Resolve relative to this package, not to the terminal's working directory.
const toolRoot = fileURLToPath(new URL('../', import.meta.url));

export async function renderVideo(config: VideoConfig): Promise<string> {
  const inputProps = validateVideoConfig(config);
  const outputDirectory = path.join(toolRoot, 'output');
  await mkdir(outputDirectory, { recursive: true });

  const serveUrl = await bundle({
    entryPoint: path.join(toolRoot, 'remotion/index.tsx'),
    rootDir: toolRoot,
  });
  const composition = await selectComposition({
    serveUrl,
    id: 'AdVideo',
    inputProps,
  });
  const outputLocation = path.join(outputDirectory, `video-${Date.now()}.mp4`);
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    outputLocation,
    inputProps,
  });
  return outputLocation;
}
