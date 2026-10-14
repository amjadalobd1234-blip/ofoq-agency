import dotenv from 'dotenv';
import readline from 'node:readline/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { localPath, loadSettings } from './runtime';
import { generateAd } from './pipeline';
import { categorySchema, type Category } from './config';

export function parseCliArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      description: { type: 'string', short: 'd' },
      template: { type: 'string', short: 't', default: 'perfume' },
      productName: { type: 'string' },
      benefit: { type: 'string' },
      price: { type: 'string' },
      'non-interactive': { type: 'boolean', default: false },
      // Accept the camelCase spelling as well as the documented CLI flag.
      nonInteractive: { type: 'boolean', default: false },
    },
  });
  const nonInteractive = values['non-interactive'] || values.nonInteractive;
  const template = categorySchema.safeParse(values.template);
  if (!template.success) throw new Error('--template يجب أن يكون perfume / restaurant / clothing / services.');
  if (nonInteractive && (!values.description?.trim() || values.description.length > 500)) {
    throw new Error('--description مطلوب في الوضع غير التفاعلي، بحد أقصى 500 حرف.');
  }
  return { ...values, template: template.data, nonInteractive };
}

export async function main(args: string[] = process.argv.slice(2)) {
  const values = parseCliArgs(args);
  dotenv.config({ path: localPath('.env') });
  let description: string;
  let category: Category;
  if (values.nonInteractive) {
    // Validated before creating any readline interface or starting the pipeline.
    description = values.description!;
    category = values.template;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      description = await rl.question('اكتب وصف الإعلان: ');
      const selection = await rl.question('اختر القالب: [1] عطور [2] مطاعم [3] ملابس [4] خدمات: ');
      const categories: Record<string, Category> = { '1': 'perfume', '2': 'restaurant', '3': 'clothing', '4': 'services', '١': 'perfume', '٢': 'restaurant', '٣': 'clothing', '٤': 'services' };
      category = categories[selection.trim()];
      if (!category) throw new Error('اختر رقمًا من 1 إلى 4.');
    } finally { rl.close(); }
  }
  const output = await generateAd(description, category, loadSettings(), {
    productName: values.productName, benefit: values.benefit, price: values.price,
  });
  console.log(`✅ الفيديو جاهز: ${path.relative(process.cwd(), output)}`);
}

// Importing the parser/main in tests must not launch a second CLI session.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error('خطأ:', error instanceof Error ? error.message : String(error));
    console.error('راجع README وخطوات إعداد النماذج المحلية. لا يوجد بديل سحابي.');
    process.exitCode = 1;
  });
}
