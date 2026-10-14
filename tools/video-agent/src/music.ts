import { localPath, type Settings } from './runtime';
import { normalizeDuration } from './config';
import { runCommand, requireFile, type Command } from './process';
export function buildMusicCommand(settings: Settings, duration: number, output: string): Command {
  return {
    executable: settings.PYTHON_BIN,
    args: [localPath('python/music_generate.py'), '--duration', String(normalizeDuration(duration)), '--output', output],
  };
}
export async function generateMusic(settings: Settings, duration: number, output: string) {
  await runCommand(buildMusicCommand(settings, duration, output));
  await requireFile(output);
  return output;
}
