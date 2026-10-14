// Shared, browser-safe definitions: never import the Groq SDK into Remotion.
export type VideoConfig = {
  duration: number;
  title: string;
  subtitle: string;
  backgroundColor: string;
  textColor: string;
  accentColor: string;
};

export const FPS = 30;
export const DEFAULT_DURATION = 15;
export const MIN_DURATION = 5;
export const MAX_DURATION = 60;

export function normalizeDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DURATION;
  }
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(value)));
}

export function validateVideoConfig(value: unknown): VideoConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('استجابة Groq ليست كائن JSON صالحًا.');
  }
  const input = value as Record<string, unknown>;
  const text = (key: string, maxLength: number): string => {
    const field = input[key];
    if (typeof field !== 'string' || !field.trim() || field.trim().length > maxLength) {
      throw new Error(`حقل ${key} يجب أن يكون نصًا غير فارغ لا يتجاوز ${maxLength} حرفًا.`);
    }
    return field.trim();
  };
  const color = (key: string): string => {
    const field = input[key];
    if (typeof field !== 'string' || !/^#[\da-f]{6}$/i.test(field)) {
      throw new Error(`حقل ${key} يجب أن يكون لون HEX مثل #D4AF37.`);
    }
    return field;
  };
  return {
    duration: normalizeDuration(input.duration),
    title: text('title', 100),
    subtitle: text('subtitle', 240),
    backgroundColor: color('backgroundColor'),
    textColor: color('textColor'),
    accentColor: color('accentColor'),
  };
}
