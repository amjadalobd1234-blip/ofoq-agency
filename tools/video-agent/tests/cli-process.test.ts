import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolRoot } from '../src/runtime';

// Real npm/tsx/CLI processes, no model downloads or heavy-stage mocks.
// Each invocation must exit before the timeout, even with no terminal input.
describe('non-interactive CLI process', () => {
  it.each([
    { args: ['--non-interactive'], error: '--description' },
    { args: ['-d', 'إعلان وهمي', '-t', 'invalid', '--non-interactive'], error: '--template' },
    { args: ['--description', 'فيديو عطر تجريبي، 15 ثانية', '--template', 'perfume',
      '--productName', 'عطر الاختبار', '--benefit', 'ميزة تجريبية', '--price', '1 دينار', '--non-interactive'], error: 'ملف مفقود أو فارغ' },
  ])('exits with a useful error: $error', ({ args, error }) => {
    const missingModels = mkdtempSync(path.join(os.tmpdir(), 'cli-no-models-'));
    try {
      const result = spawnSync('npm', ['start', '--', ...args], {
        cwd: toolRoot,
        env: { ...process.env, BROWSER_EXECUTABLE: '/test/chrome', TTS_MODEL_DIR: missingModels,
          TTS_ENGINE: 'piper', TTS_VOICE: 'ar_JO-kareem-medium', TEMPLATE_LANG: 'ar' },
        encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(result.stdout).not.toContain('اكتب وصف الإعلان:');
      expect(result.stdout).not.toContain('اختر القالب:');
      expect(result.stdout).not.toContain('الفيديو جاهز:');
      if (error === 'ملف مفقود أو فارغ') {
        expect(result.stdout).toContain('عطر الاختبار — ميزة تجريبية');
        expect(result.stdout).toContain('اطلبه الآن بـ 1 دينار');
      }
    } finally { rmSync(missingModels, { recursive: true, force: true }); }
  }, 20_000);
});
