export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <svg className={`brand-mark${small ? " brand-mark-small" : ""}`} viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <path d="M22 2.75 41.25 22 22 41.25 2.75 22 22 2.75Z" stroke="currentColor" strokeWidth="1.15" />
      <path d="M22 9.5 34.5 22 22 34.5 9.5 22 22 9.5Z" stroke="currentColor" strokeWidth="1.15" />
      <path d="M22 15v14M15 22h14" stroke="currentColor" strokeWidth="1.15" />
      <circle cx="22" cy="22" r="2.1" fill="currentColor" />
    </svg>
  );
}

export function Brand({ footer = false, locale = "ar" }: { footer?: boolean; locale?: "ar" | "en" }) {
  const ar = locale === "ar";
  return (
    <a className={`brand${footer ? " brand-footer" : ""}`} href="/" aria-label={ar ? "أفق — الرئيسية" : "Ofoq — home"}>
      <BrandMark />
      <span className="brand-copy">
        <span className="brand-name">أفق</span>
        <span className="brand-caption">{ar ? "منصة التسويق الذكي" : "INTELLIGENT MARKETING PLATFORM"}</span>
      </span>
    </a>
  );
}
