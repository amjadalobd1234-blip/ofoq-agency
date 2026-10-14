import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { toolRoot } from './runtime';
export type Command = { executable: string; args: string[]; cwd?: string; timeoutMs?: number };
export function runCommand(command: Command): Promise<void> {
  return new Promise((resolve, reject) => {
    // User text/paths are separate argv entries; never interpolate into a shell.
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd ?? toolRoot, shell: false, stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', DO_NOT_TRACK: '1', PYTHONUTF8: '1' },
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), command.timeoutMs ?? 60 * 60_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command.executable} failed (${signal ?? code}). راجع سجل المرحلة أعلاه.`));
    });
  });
}
export async function requireFile(filename: string) {
  const info = await stat(filename).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`ملف مفقود أو فارغ: ${filename}`);
}
