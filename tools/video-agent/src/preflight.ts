import path from 'node:path';
import { requireFile, runCommand } from './process';
import { localPath, type Settings } from './runtime';
import { browserEnv, resolveBrowserExecutable } from './browser';

export async function preflight(settings: Settings) {
  const model = path.join(localPath(settings.TTS_MODEL_DIR), `${settings.TTS_VOICE}.onnx`);
  for (const filename of [model, `${model}.json`, localPath(settings.DEFAULT_AVATAR)]) {
    await requireFile(filename);
  }
  // Fails with an actionable message instead of letting Remotion download a browser.
  const browserExecutable = await resolveBrowserExecutable(browserEnv(settings));
  console.log(`🌐 المتصفح: ${browserExecutable}`);
  for (const filename of [browserExecutable, localPath(settings.SADTALKER_PYTHON),
    localPath(`${settings.SADTALKER_DIR}/inference.py`), localPath('assets/logo.svg')]) {
    await requireFile(filename);
  }
  if (settings.FONT_FILE) {
    if (!settings.FONT_FILE.endsWith('.woff2')) throw new Error('FONT_FILE يجب أن يكون WOFF2 محليًا.');
    await requireFile(localPath(settings.FONT_FILE));
  }
  await runCommand({ executable: settings.FFMPEG_PATH, args: ['-version'], timeoutMs: 10_000 });
  await runCommand({ executable: settings.FFPROBE_PATH, args: ['-version'], timeoutMs: 10_000 });
  await runCommand({ executable: settings.PYTHON_BIN, args: ['-c', 'import piper, numpy, scipy'], timeoutMs: 30_000 });
  await runCommand({ executable: localPath(settings.SADTALKER_PYTHON), args: [
    localPath('python/avatar_generate.py'), '--check', '--sadtalker_dir', localPath(settings.SADTALKER_DIR),
    '--device', settings.AVATAR_DEVICE,
  ], timeoutMs: 60_000 });
}
