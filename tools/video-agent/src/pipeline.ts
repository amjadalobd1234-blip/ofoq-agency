import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { generateScript } from './script';
import { generateVoice } from './voice';
import { generateAvatar } from './avatar';
import { generateMusic } from './music';
import { renderVideo } from './render';
import { preflight } from './preflight';
import { localPath, type Settings } from './runtime';
import type { Category, VideoConfig } from './config';

export async function generateAd(description: string, category: Category, settings: Settings, options: {
  productName?: string; benefit?: string; price?: string;
} = {}) {
  console.log('⏳ كتابة السيناريو...');
  const script = generateScript(description, category, { ...options, lang: settings.TEMPLATE_LANG });
  console.log(`✅ hook: "${script.hook}"\n   body: "${script.body}"\n   cta: "${script.cta}"\n   المدة: ${script.duration}s`);
  await preflight(settings);
  const outputRoot = localPath(settings.OUTPUT_DIR);
  await mkdir(outputRoot, { recursive: true });
  const prefix = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = await mkdtemp(path.join(outputRoot, `${prefix}-`));
  const scriptPath = path.join(runDirectory, 'script.json');
  await writeFile(scriptPath, JSON.stringify(script, null, 2));
  console.log('⏳ توليد الصوت...');
  await generateVoice(settings, scriptPath, path.join(runDirectory, 'voice.wav'));
  console.log('✅ voice.wav\n⏳ توليد فيديو الشخص...');
  await generateAvatar(settings, path.join(runDirectory, 'voice.wav'), runDirectory);
  console.log('✅ avatar.mp4\n⏳ توليد الموسيقى...');
  await generateMusic(settings, script.duration, path.join(runDirectory, 'music.wav'));
  console.log('✅ music.wav\n⏳ تركيب الفيديو...');
  const palettes: Record<Category, [string, string]> = {
    perfume: ['#101018', '#D4AF37'], restaurant: ['#18120E', '#FFB366'],
    clothing: ['#151322', '#D0B7FF'], services: ['#0B1820', '#62D9CA'],
  };
  const [backgroundColor, accentColor] = palettes[category];
  const config: VideoConfig = {
    duration: script.duration, fps: settings.FPS, width: settings.WIDTH, height: settings.HEIGHT,
    script, backgroundColor, accentColor, textColor: '#FFFFFF',
    media: { avatar: 'avatar.mp4', voice: 'voice.wav', music: 'music.wav', logo: 'logo.svg',
      ...(settings.FONT_FILE ? { font: 'font.woff2' } : {}) },
  };
  await writeFile(path.join(runDirectory, 'config.json'), JSON.stringify(config, null, 2));
  return renderVideo(config, settings, runDirectory);
}
