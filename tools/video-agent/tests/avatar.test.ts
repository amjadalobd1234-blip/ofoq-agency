import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SADTALKER_INSTALL_HINT,
  avatarFileExists,
  buildAvatarCommand,
  buildFallbackAvatarCommand,
  generateAvatar,
  resolveAvatarMode,
  resolveSadTalkerDir,
  resolveSadTalkerPython,
} from '../src/avatar';
import { loadSettings, localPath } from '../src/runtime';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'avatar-test-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

const existing = (files: string[]) => async (candidate: string) => files.includes(candidate);

describe('SadTalker verification and environment resolution', () => {
  it('uses SADTALKER_DIR from env when building commands and resolving python', async () => {
    const env = { SADTALKER_DIR: '/content/SadTalker', AVATAR_MODE: 'sadtalker' };
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium' });
    expect(resolveSadTalkerDir(settings, env)).toBe('/content/SadTalker');
    const python = '/content/SadTalker/.venv-sadtalker/bin/python';
    await expect(resolveSadTalkerPython(settings, env, existing([python]))).resolves.toBe(python);
    const command = buildAvatarCommand(settings, '/tmp/voice.wav', '/tmp/out', env);
    expect(command.executable).toBe(python);
    expect(command.args).toContain('/content/SadTalker');
  });

  it('verifies a real .venv-sadtalker/bin/python file on disk and rejects missing or empty files', async () => {
    const sadtalkerDir = path.join(directory, 'SadTalker');
    const venvBin = path.join(sadtalkerDir, '.venv-sadtalker/bin');
    await mkdir(venvBin, { recursive: true });
    const python = path.join(venvBin, 'python');
    const emptyPython = path.join(venvBin, 'empty-python');
    await writeFile(python, '#!/bin/sh\nexit 0\n');
    await chmod(python, 0o755);
    await writeFile(emptyPython, '');

    expect(await avatarFileExists(python)).toBe(true);
    expect(await avatarFileExists(emptyPython)).toBe(false);
    expect(await avatarFileExists(path.join(venvBin, 'missing'))).toBe(false);
    expect(await avatarFileExists(venvBin)).toBe(false);

    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium', SADTALKER_DIR: sadtalkerDir });
    await expect(resolveSadTalkerPython(settings, { SADTALKER_DIR: sadtalkerDir })).resolves.toBe(python);
  });

  it('resolves relative SADTALKER_DIR against the tool directory', () => {
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium' });
    expect(resolveSadTalkerDir(settings, { SADTALKER_DIR: 'vendor/custom-sadtalker' })).toBe(
      localPath('vendor/custom-sadtalker'),
    );
  });
});

describe('clear installation error when SadTalker is missing', () => {
  it('throws a clear message with installation steps when .venv-sadtalker/bin/python does not exist', async () => {
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium' });
    const env = { SADTALKER_DIR: '/content/SadTalker', AVATAR_MODE: 'sadtalker' };
    const error = await resolveSadTalkerPython(settings, env, existing([])).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('/content/SadTalker/.venv-sadtalker/bin/python');
    expect(message).toContain('SADTALKER_DIR');
    expect(message).toContain('git clone https://github.com/OpenTalker/SadTalker.git /content/SadTalker');
    expect(message).toContain('bash scripts/download_models.sh');
    expect(message).toContain('python -m venv /content/SadTalker/.venv-sadtalker');
    expect(message).toContain('pip install -q -r /content/SadTalker/requirements.txt');
    expect(message).toContain('AVATAR_MODE=auto');
    expect(message).toContain(SADTALKER_INSTALL_HINT);
  });

  it('stops generateAvatar before running SadTalker when .venv-sadtalker/bin/python is missing in sadtalker mode', async () => {
    const run = vi.fn();
    const checkFile = vi.fn();
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium' });
    const env = { SADTALKER_DIR: '/missing/SadTalker', AVATAR_MODE: 'sadtalker' };
    await expect(
      generateAvatar(settings, '/tmp/voice.wav', directory, { env, exists: existing([]), run, checkFile }),
    ).rejects.toThrow(/خطوات تثبيت SadTalker الكامل/);
    expect(run).not.toHaveBeenCalled();
    expect(checkFile).not.toHaveBeenCalled();
  });
});

describe('fallback to auto mode on missing or failing SadTalker', () => {
  it('resolves avatar mode from settings and environment', () => {
    expect(resolveAvatarMode(undefined, {})).toBe('sadtalker');
    expect(resolveAvatarMode(undefined, { AVATAR_MODE: 'auto' })).toBe('auto');
    expect(resolveAvatarMode({ AVATAR_MODE: 'auto' }, { AVATAR_MODE: 'sadtalker' })).toBe('auto');
  });

  it('falls back to auto mode when AVATAR_MODE=auto and SadTalker is not installed', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const checkFile = vi.fn().mockResolvedValue(undefined);
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium', AVATAR_MODE: 'auto' });
    const output = await generateAvatar(settings, '/tmp/voice.wav', directory, {
      env: { SADTALKER_DIR: '/missing/SadTalker', AVATAR_MODE: 'auto' },
      exists: existing([]),
      run,
      checkFile,
    });
    expect(output).toBe(`${directory}/avatar.mp4`);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(buildFallbackAvatarCommand(settings, '/tmp/voice.wav', `${directory}/avatar.mp4`));
    expect(checkFile).toHaveBeenCalledWith(`${directory}/avatar.mp4`);
  });

  it('falls back automatically to auto mode when SadTalker fails at runtime (e.g. Colab RAM limit)', async () => {
    const python = '/content/SadTalker/.venv-sadtalker/bin/python';
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('SadTalker killed (OOM)'))
      .mockResolvedValueOnce(undefined);
    const checkFile = vi.fn().mockResolvedValue(undefined);
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium' });
    const env = { SADTALKER_DIR: '/content/SadTalker', AVATAR_MODE: 'sadtalker' };

    const output = await generateAvatar(settings, '/tmp/voice.wav', directory, {
      env,
      exists: existing([python]),
      run,
      checkFile,
    });
    expect(output).toBe(`${directory}/avatar.mp4`);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0].executable).toBe(python);
    expect(run.mock.calls[1][0]).toEqual(buildFallbackAvatarCommand(settings, '/tmp/voice.wav', `${directory}/avatar.mp4`));
  });

  it('rethrows the original SadTalker error if both SadTalker and the fallback fail', async () => {
    const python = '/content/SadTalker/.venv-sadtalker/bin/python';
    const run = vi.fn().mockRejectedValue(new Error('SadTalker runtime failure'));
    const checkFile = vi.fn();
    const settings = loadSettings({ BROWSER_EXECUTABLE: '/usr/bin/chromium' });
    const env = { SADTALKER_DIR: '/content/SadTalker', AVATAR_MODE: 'sadtalker' };

    await expect(
      generateAvatar(settings, '/tmp/voice.wav', directory, {
        env,
        exists: existing([python]),
        run,
        checkFile,
      }),
    ).rejects.toThrow('SadTalker runtime failure');
  });
});
