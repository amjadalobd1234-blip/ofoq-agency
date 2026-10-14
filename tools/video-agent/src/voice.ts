import path from 'node:path';
import { localPath, type Settings } from './runtime';
import { runCommand, requireFile, type Command } from './process';
export function buildVoiceCommand(settings: Settings, scriptPath: string, output: string): Command {
  return {
    executable: settings.PYTHON_BIN,
    args: [localPath('python/tts_generate.py'), '--script', scriptPath,
      '--model', path.join(localPath(settings.TTS_MODEL_DIR), `${settings.TTS_VOICE}.onnx`),
      '--rate', String(settings.TTS_RATE), '--fps', String(settings.FPS),
      '--ffmpeg', settings.FFMPEG_PATH, '--output', output],
  };
}
export async function generateVoice(settings: Settings, scriptPath: string, output: string) {
  await runCommand(buildVoiceCommand(settings, scriptPath, output));
  await requireFile(output);
  return output;
}
