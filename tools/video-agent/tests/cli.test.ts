import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ generateAd: vi.fn(), question: vi.fn(), close: vi.fn(), createInterface: vi.fn() }));
vi.mock('../src/pipeline', () => ({ generateAd: mocks.generateAd }));
vi.mock('node:readline/promises', () => ({ default: { createInterface: mocks.createInterface } }));
import { main, parseCliArgs } from '../src/index';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('BROWSER_EXECUTABLE', '/test/chrome');
  mocks.generateAd.mockResolvedValue('/test/output/ad.mp4');
  mocks.createInterface.mockReturnValue({ question: mocks.question, close: mocks.close });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('CLI arguments', () => {
  it('defaults to interactive mode and the perfume template', () => {
    expect(parseCliArgs([])).toMatchObject({ nonInteractive: false, template: 'perfume' });
  });
  it.each(['--non-interactive', '--nonInteractive'])('supports %s and short arguments', (flag) => {
    expect(parseCliArgs(['-d', 'إعلان مطعم', '-t', 'restaurant', flag])).toMatchObject({
      description: 'إعلان مطعم', template: 'restaurant', nonInteractive: true,
    });
  });
  it.each(['perfume', 'restaurant', 'clothing', 'services'])('accepts template %s', (template) => {
    expect(parseCliArgs(['-d', 'إعلان', '-t', template, '--non-interactive']).template).toBe(template);
  });
  it('preserves Arabic text, quotes and shell metacharacters as literal arguments', () => {
    const description = 'عطر "ذهب"; $(echo not-a-command)\n15 ثانية';
    expect(parseCliArgs(['--description', description, '--non-interactive']).description).toBe(description);
  });
  it.each([
    ['--non-interactive'],
    ['--non-interactive', '-d', '   '],
    ['--non-interactive', '-d', 'x'.repeat(501)],
    ['--non-interactive', '-d', 'إعلان', '-t', 'invalid'],
    ['--description'],
    ['--non-interactiv'],
    ['unexpected-positional'],
  ])('rejects invalid arguments %j without prompting or generating', async (...args) => {
    await expect(main(args)).rejects.toThrow();
    expect(mocks.createInterface).not.toHaveBeenCalled();
    expect(mocks.generateAd).not.toHaveBeenCalled();
  });
  it('passes all fields to the pipeline without ever opening readline', async () => {
    await main(['--description', 'فيديو لعطر، 15 ثانية', '--template', 'perfume',
      '--productName', 'عطر الذهب', '--benefit', 'يدوم 24 ساعة', '--price', '50,000 دينار', '--non-interactive']);
    expect(mocks.createInterface).not.toHaveBeenCalled();
    expect(mocks.generateAd).toHaveBeenCalledWith('فيديو لعطر، 15 ثانية', 'perfume',
      expect.objectContaining({ BROWSER_EXECUTABLE: '/test/chrome' }),
      { productName: 'عطر الذهب', benefit: 'يدوم 24 ساعة', price: '50,000 دينار' });
  });
  it('uses the default template in non-interactive mode', async () => {
    await main(['-d', 'إعلان', '--non-interactive']);
    expect(mocks.generateAd).toHaveBeenCalledWith('إعلان', 'perfume', expect.anything(), expect.anything());
    expect(mocks.createInterface).not.toHaveBeenCalled();
  });
  it.each(['2', '٢'])('preserves interactive prompts and numeric selection %s', async (selection) => {
    mocks.question.mockResolvedValueOnce('إعلان مطعم').mockResolvedValueOnce(selection);
    await main([]);
    expect(mocks.question).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.generateAd).toHaveBeenCalledWith('إعلان مطعم', 'restaurant', expect.anything(), expect.anything());
  });
  it('closes readline on invalid interactive selection', async () => {
    mocks.question.mockResolvedValueOnce('إعلان').mockResolvedValueOnce('9');
    await expect(main([])).rejects.toThrow('اختر رقمًا');
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.generateAd).not.toHaveBeenCalled();
  });
  it('propagates generation failures without switching to interactive mode', async () => {
    mocks.generateAd.mockRejectedValue(new Error('missing models'));
    await expect(main(['-d', 'إعلان', '--non-interactive'])).rejects.toThrow('missing models');
    expect(mocks.createInterface).not.toHaveBeenCalled();
  });
});
