import { z } from 'zod';

export const FPS = 30;
export const DEFAULT_DURATION = 15;
export function normalizeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(60, Math.max(5, Math.round(value))) : DEFAULT_DURATION;
}
export const categorySchema = z.enum(['perfume', 'restaurant', 'clothing', 'services']);
export type Category = z.infer<typeof categorySchema>;
export const languageSchema = z.enum(['ar', 'en']);
export type Language = z.infer<typeof languageSchema>;
const text = z.string().trim().min(1).max(240);
export const scriptSchema = z.object({
  duration: z.number().int().min(5).max(60),
  lang: languageSchema,
  category: categorySchema,
  productName: text,
  hook: text,
  body: text,
  cta: text,
});
export type AdScript = z.infer<typeof scriptSchema>;
// Only staged filenames, never remote URLs or arbitrary filesystem paths.
const asset = z.string().regex(/^[a-zA-Z0-9_-]+\.(?:mp4|wav|svg|woff2)$/);
export const videoConfigSchema = z.object({
  duration: z.number().int().min(5).max(60),
  fps: z.number().int().min(24).max(60),
  width: z.number().int().min(320).max(2160).multipleOf(2),
  height: z.number().int().min(320).max(2160).multipleOf(2),
  script: scriptSchema,
  backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  textColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  media: z.object({
    logo: asset, avatar: asset.optional(), voice: asset.optional(), music: asset.optional(), font: asset.optional(),
  }),
});
export type VideoConfig = z.infer<typeof videoConfigSchema>;

// Shared by voice timing, composition and tests to prevent lip-sync drift.
export function sceneFrames(duration: number, fps: number) {
  const total = normalizeDuration(duration) * fps;
  const bodyStart = Math.round(total * 0.15);
  const ctaStart = Math.round(total * 0.75);
  const speechEnd = Math.round(total * 0.95);
  return { total, bodyStart, ctaStart, speechEnd };
}
