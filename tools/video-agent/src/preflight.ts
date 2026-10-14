import path from 'node:path';
import { requireFile, runCommand } from './process';
import { localPath, type Settings } from './runtime';
import { browserEnv, resolveBrowserExecutable } from './browser';
import { resolveAvatarMode, resolveSadTalkerDir, resolveSadTalkerPython } from './avatar';

export async function preflight(settings: Settings) {
  const model = path.join(localPath(settings.TTS_MODEL_DIR), `${settings.TTS_VOICE}.onnx`);
  for (const filename of [model, `${model}.json`, localPath(settings.DEFAULT_AVATAR)]) {
    await requireFile(filename);
  }
  // Fails with an actionable message instead of letting Remotion download a browser.
  const browserExecutable = await resolveBrowserExecutable(browserEnv(settings));
  console.log(`🌐 المتصفح: ${browserExecutable}`);
  await requireFile(browserExecutable);
  await requireFile(localPath('assets/logo.svg'));
  if (settings.FONT_FILE) {
    if (!settings.FONT_FILE.endsWith('.woff2')) throw new Error('FONT_FILE يجب أن يكون WOFF2 محليًا.');
    await requireFile(localPath(settings.FONT_FILE));
  }
  const sadtalkerDir = resolveSadTalkerDir(settings);
  const avatarMode = resolveAvatarMode(settings);
  let sadtalkerPython: string | undefined;
  try {
    sadtalkerPython = await resolveSadTalkerPython(settings);
    await requireFile(path.join(sadtalkerDir, 'inference.py'));
  } catch (error) {
    if (avatarMode !== 'auto') throw error;
    console.warn('⚠️ SadTalker غير مكتمل؛ سيتم استخدام الوضع التلقائي (auto) عند توليد الفيديو.');
  }
  await runCommand({ executable: settings.FFMPEG_PATH, args: ['-version'], timeoutMs: 10_000 });
  await runCommand({ executable: settings.FFPROBE_PATH, args: ['-version'], timeoutMs: 10_000 });
  await runCommand({ executable: settings.PYTHON_BIN, args: ['-c', 'import piper, numpy, scipy'], timeoutMs: 30_000 });
  if (sadtalkerPython) {
    try {
      await runCommand({ executable: sadtalkerPython, args: [
        localPath('python/avatar_generate.py'), '--check', '--sadtalker_dir', sadtalkerDir,
        '--device', settings.AVATAR_DEVICE,
      ], timeoutMs: 60_000 });
    } catch (error) {
      if (avatarMode !== 'auto') throw error;
      console.warn('⚠️ فشل فحص SadTalker؛ سيتم استخدام الوضع التلقائي (auto) عند توليد الفيديو.');
    }
  }
}
