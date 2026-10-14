import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { languageSchema } from './config';
export const toolRoot = fileURLToPath(new URL('../', import.meta.url));
export const localPath = (value: string) => path.resolve(toolRoot, value);
const environment = z.object({
  TTS_ENGINE: z.literal('piper').default('piper'),
  TTS_VOICE: z.string().regex(/^[a-z]{2}_[A-Z]{2}-[\w-]+$/).default('ar_JO-kareem-medium'),
  TTS_RATE: z.coerce.number().min(0.5).max(2).default(1),
  TTS_MODEL_DIR: z.string().default('models/piper'),
  AVATAR_ENGINE: z.literal('sadtalker').default('sadtalker'),
  AVATAR_MODE: z.enum(['sadtalker', 'auto']).default('sadtalker'),
  DEFAULT_AVATAR: z.string().default('assets/avatars/man-1.png'),
  SADTALKER_DIR: z.string().default('vendor/SadTalker'),
  SADTALKER_PYTHON: z.string().default('.venv-sadtalker/bin/python'),
  AVATAR_DEVICE: z.enum(['cpu', 'cuda']).default('cpu'),
  PYTHON_BIN: z.string().min(1).default('python3'),
  FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().min(1).default('ffprobe'),
  // Empty means auto-detect: src/browser.ts scans the env and known system paths at run time.
  BROWSER_EXECUTABLE: z.string().default(''),
  OUTPUT_DIR: z.string().default('output/'),
  FPS: z.coerce.number().int().min(24).max(60).default(30),
  WIDTH: z.coerce.number().int().min(320).max(2160).multipleOf(2).default(1080),
  HEIGHT: z.coerce.number().int().min(320).max(2160).multipleOf(2).default(1080),
  TEMPLATE_LANG: languageSchema.default('ar'),
  FONT_FILE: z.string().default(''),
});
export function loadSettings(env: NodeJS.ProcessEnv = process.env) {
  const settings = environment.parse(env);
  if (!settings.TTS_VOICE.startsWith(`${settings.TEMPLATE_LANG}_`)) {
    throw new Error('TTS_VOICE يجب أن يطابق TEMPLATE_LANG. ثبّت صوتًا إنجليزيًا لاستخدام en.');
  }
  return settings;
}
export type Settings = ReturnType<typeof loadSettings>;
