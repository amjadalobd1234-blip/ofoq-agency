/**
 * Display helpers for the client-facing Arabic messages.
 *
 * A range is wrapped in LTR isolates (U+2066 … U+2069, see `isolateLtr()` in
 * src/lib/agents/pricing-agent.ts) so an Arabic right-to-left line cannot
 * reorder «~92,000-172,000» into «~172,000-92,000» on screen. Tests that assert
 * what the client *reads* run the text through `plainText()`; the dedicated
 * display tests assert the isolates themselves are there.
 */
const BIDI_ISOLATES = /[\u2066\u2069]/g;

/** The message as the client reads it: bidi isolates removed. */
export function plainText(value: string): string {
  return value.replace(BIDI_ISOLATES, "");
}

/** The same, for every message of a thread (in screen order). */
export function plainTexts(values: string[]): string[] {
  return values.map((value) => plainText(value));
}
