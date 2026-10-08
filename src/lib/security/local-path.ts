const LOCAL_BASE = "https://ofoq.invalid";

/** Accept only same-origin absolute paths for post-auth redirects. */
export function safeLocalPath(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }

  try {
    const url = new URL(value, LOCAL_BASE);
    if (url.origin !== LOCAL_BASE) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
