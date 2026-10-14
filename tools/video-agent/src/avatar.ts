import { localPath, type Settings } from './runtime';
import { runCommand, requireFile, type Command } from './process';
export function buildAvatarCommand(settings: Settings, audio: string, resultDirectory: string): Command {
  return {
    executable: localPath(settings.SADTALKER_PYTHON),
    args: [localPath('python/avatar_generate.py'), '--source', localPath(settings.DEFAULT_AVATAR),
      '--driven_audio', audio, '--result_dir', resultDirectory,
      '--sadtalker_dir', localPath(settings.SADTALKER_DIR), '--device', settings.AVATAR_DEVICE,
      '--ffmpeg', settings.FFMPEG_PATH],
  };
}
export async function generateAvatar(settings: Settings, audio: string, resultDirectory: string) {
  const output = `${resultDirectory}/avatar.mp4`;
  await runCommand(buildAvatarCommand(settings, audio, resultDirectory));
  await requireFile(output);
  return output;
}
