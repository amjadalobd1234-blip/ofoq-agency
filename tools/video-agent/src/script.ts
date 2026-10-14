import ar from '../templates/script-ar.json';
import en from '../templates/script-en.json';
import { categorySchema, languageSchema, normalizeDuration, scriptSchema, type AdScript, type Category, type Language } from './config';

export function parseDuration(description: string): number {
  const normalized = description.replace(/[٠-٩۰-۹]/g, (n) => String('٠١٢٣٤٥٦٧٨٩'.includes(n)
    ? '٠١٢٣٤٥٦٧٨٩'.indexOf(n) : '۰۱۲۳۴۵۶۷۸۹'.indexOf(n))).replace(/٫/g, '.');
  const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*(ثاني[ةه]|ثوان(?:ي|ٍ)?|seconds?\b|secs?\b|s\b|دقيق[ةه]|دقائق|minutes?\b|mins?\b)/i);
  if (match) return normalizeDuration(Number(match[1]) * (/دقيق|minute|min/i.test(match[2]) ? 60 : 1));
  if (/نصف دقيقة/.test(normalized)) return 30;
  if (/ربع دقيقة/.test(normalized)) return 15;
  if (/ثانيت[اي]ن/.test(normalized)) return 5;
  if (/دقيقت[اي]ن|دقيقة|one minute/i.test(normalized)) return 60;
  const words: Record<string, number> = { خمس: 5, خمسة: 5, عشر: 10, عشرة: 10, عشرين: 20, عشرون: 20, ثلاثين: 30, ثلاثون: 30, ستين: 60, ستون: 60 };
  for (const [word, seconds] of Object.entries(words)) {
    if (new RegExp(`(?:^|\\s)${word}\\s+ثوان|(?:^|\\s)${word}\\s+ثانية`).test(normalized)) return seconds;
  }
  return 15;
}

function fill(template: string, fields: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (!fields[key]) throw new Error(`Missing template field: ${key}`);
    return fields[key];
  });
}

export function generateScript(description: string, category: Category, options: {
  lang?: Language; productName?: string; benefit?: string; price?: string; variant?: number;
} = {}): AdScript {
  if (!description.trim() || description.length > 500) throw new Error('الوصف مطلوب، بحد أقصى 500 حرف.');
  categorySchema.parse(category);
  const lang = languageSchema.parse(options.lang ?? 'ar');
  const template = (lang === 'ar' ? ar : en)[category];
  const duration = parseDuration(description);
  // A deliberately simple local parser, not a claim of semantic AI understanding.
  const quoted = description.match(/["«](.{1,60}?)["»]/)?.[1];
  const extracted = description.split(/[,،]/)[0]
    .replace(/^(?:فيديو|إعلان|اعلان|video|ad)\s*/i, '').replace(/^(?:إعلاني|اعلاني)\s*/, '')
    .replace(/^ل(?=عطر|مطعم|ملابس|خدم)/, '')
    .replace(/[\d٠-٩۰-۹]+\s*(?:ثانية|ثواني|seconds?|دقيقة|minutes?).*$/i, '').trim();
  const productName = (options.productName?.trim() || quoted || extracted || template.defaultProduct).slice(0, 60);
  const fields = { productName, benefit: options.benefit?.trim() || template.defaultBenefit, price: options.price?.trim() || '' };
  const variant = Math.abs(Math.trunc(options.variant ?? 0));
  // Never invent a price or leave an unresolved placeholder in the narration.
  const ctas = template.ctas.filter((cta) => !cta.includes('{price}') || fields.price);
  const short = duration <= 8;
  return scriptSchema.parse({
    duration, category, lang, productName,
    hook: short ? template.short.hook : template.hooks[variant % template.hooks.length],
    body: fill(short ? template.short.body : template.bodyTemplates[variant % template.bodyTemplates.length], fields),
    cta: fill(short ? template.short.cta : ctas[variant % ctas.length], fields),
  });
}
