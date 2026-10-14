import dotenv from 'dotenv';
import readline from 'node:readline/promises';
import path from 'node:path';
import { localPath, loadSettings } from './runtime';
import { generateAd } from './pipeline';
import type { Category } from './config';

dotenv.config({ path: localPath('.env') });
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const description = await rl.question('اكتب وصف الإعلان: ');
    const selection = await rl.question('اختر القالب: [1] عطور [2] مطاعم [3] ملابس [4] خدمات: ');
    const categories: Record<string, Category> = { '1': 'perfume', '2': 'restaurant', '3': 'clothing', '4': 'services', '١': 'perfume', '٢': 'restaurant', '٣': 'clothing', '٤': 'services' };
    const category = categories[selection.trim()];
    if (!category) throw new Error('اختر رقمًا من 1 إلى 4.');
    rl.close();
    const output = await generateAd(description, category, loadSettings());
    console.log(`✅ الفيديو جاهز: ${path.relative(process.cwd(), output)}`);
  } finally { rl.close(); }
}
main().catch((error: unknown) => {
  console.error('خطأ:', error instanceof Error ? error.message : String(error));
  console.error('راجع README وخطوات إعداد النماذج المحلية. لا يوجد بديل سحابي.');
  process.exitCode = 1;
});
