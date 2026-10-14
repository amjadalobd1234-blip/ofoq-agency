import path from 'node:path';
import { stat } from 'node:fs/promises';
import { localPath, type Settings } from './runtime';
import { runCommand, requireFile, type Command } from './process';

export type AvatarExists = (candidate: string) => Promise<boolean>;
export type AvatarMode = 'sadtalker' | 'auto';

export const avatarFileExists: AvatarExists = async (candidate) => {
  const info = await stat(candidate).catch(() => null);
  return Boolean(info?.isFile() && info.size > 0);
};

export const SADTALKER_INSTALL_HINT = [
  'خطوات تثبيت SadTalker الكامل:',
  '  1. استنساخ المستودع:',
  '     git clone https://github.com/OpenTalker/SadTalker.git /content/SadTalker',
  '  2. تثبيت المكتبات وأداة التحميل:',
  '     cd /content/SadTalker && pip install -q -r requirements.txt && pip install -q gdown',
  '  3. تحميل النماذج (~2 GB):',
  '     cd /content/SadTalker && bash scripts/download_models.sh',
  '  4. إنشاء بيئة معزولة (.venv-sadtalker):',
  '     python -m venv /content/SadTalker/.venv-sadtalker',
  '     /content/SadTalker/.venv-sadtalker/bin/pip install -q -r /content/SadTalker/requirements.txt',
  '  5. ضبط متغيرات البيئة (أو تشغيل bash python/setup_models.sh محليًا):',
  '     SADTALKER_DIR=/content/SadTalker',
  '     AVATAR_MODE=sadtalker',
  '⚠️ ملاحظة: يحتاج SadTalker ~4 GB RAM و15-25 دقيقة للتثبيت؛ عند الفشل يمكن التحويل إلى AVATAR_MODE=auto.',
].join('\n');

const absolute = (value: string) => (path.isAbsolute(value) ? value : localPath(value));

export function resolveSadTalkerDir(
  settings?: Partial<Settings>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = settings?.SADTALKER_DIR?.trim();
  const fromEnv = env.SADTALKER_DIR?.trim();
  const raw = (configured && configured !== 'vendor/SadTalker')
    ? configured
    : (fromEnv || configured || '/content/SadTalker');
  return absolute(raw);
}

export function resolveAvatarMode(
  settings?: Partial<Settings>,
  env: NodeJS.ProcessEnv = process.env,
): AvatarMode {
  const fromEnv = env.AVATAR_MODE?.trim();
  const configured = settings?.AVATAR_MODE;
  if (configured === 'auto' || fromEnv === 'auto') return 'auto';
  return 'sadtalker';
}

export function sadtalkerPythonCandidates(
  settings?: Partial<Settings>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const sadtalkerDir = resolveSadTalkerDir(settings, env);
  const venvInDir = path.join(sadtalkerDir, '.venv-sadtalker/bin/python');
  const rawPython = settings?.SADTALKER_PYTHON?.trim();
  if (!rawPython) return [venvInDir];
  const configuredPython = absolute(rawPython);
  if (rawPython !== '.venv-sadtalker/bin/python') {
    return Array.from(new Set([configuredPython, venvInDir]));
  }
  return Array.from(new Set([venvInDir, configuredPython]));
}

export async function resolveSadTalkerPython(
  settings?: Partial<Settings>,
  env: NodeJS.ProcessEnv = process.env,
  exists: AvatarExists = avatarFileExists,
): Promise<string> {
  const sadtalkerDir = resolveSadTalkerDir(settings, env);
  for (const candidate of sadtalkerPythonCandidates(settings, env)) {
    if (await exists(candidate)) return candidate;
  }
  const expectedPython = path.join(sadtalkerDir, '.venv-sadtalker/bin/python');
  throw new Error([
    `لم يتم العثور على SadTalker أو بيئة Python المعزولة (.venv-sadtalker/bin/python) في: ${expectedPython}`,
    `مجلد SadTalker المحدد (SADTALKER_DIR): ${sadtalkerDir}`,
    SADTALKER_INSTALL_HINT,
  ].join('\n'));
}

export function buildAvatarCommand(
  settings: Settings,
  audio: string,
  resultDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  pythonExecutable?: string,
): Command {
  const sadtalkerDir = resolveSadTalkerDir(settings, env);
  const defaultLocalDir = localPath('vendor/SadTalker');
  const executable = pythonExecutable ?? (
    sadtalkerDir !== defaultLocalDir && settings.SADTALKER_PYTHON === '.venv-sadtalker/bin/python'
      ? path.join(sadtalkerDir, '.venv-sadtalker/bin/python')
      : localPath(settings.SADTALKER_PYTHON)
  );
  return {
    executable,
    args: [
      localPath('python/avatar_generate.py'),
      '--source', localPath(settings.DEFAULT_AVATAR),
      '--driven_audio', audio,
      '--result_dir', resultDirectory,
      '--sadtalker_dir', sadtalkerDir,
      '--device', settings.AVATAR_DEVICE,
      '--ffmpeg', settings.FFMPEG_PATH,
    ],
  };
}

export function buildFallbackAvatarCommand(
  settings: Settings,
  audio: string,
  output: string,
): Command {
  return {
    executable: settings.FFMPEG_PATH,
    args: [
      '-y',
      '-loop', '1',
      '-i', localPath(settings.DEFAULT_AVATAR),
      '-i', audio,
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-shortest',
      output,
    ],
  };
}

export async function generateAvatar(
  settings: Settings,
  audio: string,
  resultDirectory: string,
  options: {
    env?: NodeJS.ProcessEnv;
    exists?: AvatarExists;
    run?: (command: Command) => Promise<void>;
    checkFile?: (filename: string) => Promise<void>;
  } = {},
) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? avatarFileExists;
  const run = options.run ?? runCommand;
  const checkFile = options.checkFile ?? requireFile;
  const output = `${resultDirectory}/avatar.mp4`;
  const mode = resolveAvatarMode(settings, env);

  let pythonExecutable: string;
  try {
    pythonExecutable = await resolveSadTalkerPython(settings, env, exists);
  } catch (error) {
    if (mode === 'auto') {
      console.warn('⚠️ SadTalker غير متوفر، التحويل إلى الوضع التلقائي (auto)...');
      await run(buildFallbackAvatarCommand(settings, audio, output));
      await checkFile(output);
      return output;
    }
    throw error;
  }

  try {
    await run(buildAvatarCommand(settings, audio, resultDirectory, env, pythonExecutable));
    await checkFile(output);
    return output;
  } catch (error) {
    console.warn('⚠️ فشل تشغيل SadTalker، التحويل تلقائيًا إلى الوضع auto...');
    try {
      await run(buildFallbackAvatarCommand(settings, audio, output));
      await checkFile(output);
      return output;
    } catch {
      throw error;
    }
  }
}
