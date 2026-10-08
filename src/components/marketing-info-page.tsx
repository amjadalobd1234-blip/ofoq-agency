import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { Brand } from "@/components/brand-mark";
import { LocaleSwitch } from "@/components/locale-switch";
import { PublicReviews } from "@/components/public-reviews";

type Section = "about" | "services" | "howWeWork" | "whyOfoq" | "work" | "reviews" | "faq" | "contact";

const services = [
  { ar: "إدارة حسابات التواصل الاجتماعي", en: "Social media management", detailAr: "إدارة القنوات وفق أهداف النشاط وخطة محتوى واضحة.", detailEn: "Channel management aligned with business goals and a clear content plan.", category: "01" },
  { ar: "كتابة وتصميم المنشورات", en: "Post writing and design", detailAr: "رسائل وتصاميم متناسقة مع صوت العلامة التجارية.", detailEn: "Copy and creative that stay consistent with your brand voice.", category: "02" },
  { ar: "صناعة المحتوى وخطط النشر", en: "Content creation and publishing plans", detailAr: "محتوى منظم وتقويم نشر يناسب الجمهور والمنصات.", detailEn: "Structured content and a publishing calendar for your audience and channels.", category: "03" },
  { ar: "إدارة الإعلانات المدفوعة", en: "Paid advertising management", detailAr: "تخطيط ومتابعة ضمن ميزانية يوافق عليها العميل مسبقًا.", detailEn: "Planning and management within a budget approved by the client in advance.", category: "04" },
  { ar: "تصميم الهوية والمواد التسويقية", en: "Brand identity and marketing design", detailAr: "هوية ومواد متناسقة تساعد العلامة على الظهور بوضوح.", detailEn: "A coherent identity and marketing materials that help a brand show up clearly.", category: "05" },
  { ar: "إنشاء وتطوير المواقع", en: "Website design and development", detailAr: "مواقع وتجارب رقمية مصممة لاحتياج المشروع.", detailEn: "Websites and digital experiences tailored to the project scope.", category: "06" },
  { ar: "تحسين محركات البحث SEO", en: "Search engine optimisation (SEO)", detailAr: "تحسين أساسي وتقني ومحتوى قابل للتطوير حسب نطاق العمل.", detailEn: "Foundational, technical and content optimisation scoped to the project.", category: "07" },
  { ar: "تحليل الأداء والتقارير", en: "Performance analysis and reporting", detailAr: "تقارير مبسطة تشرح المؤشرات والقرارات التالية.", detailEn: "Plain-language reports explaining key metrics and next steps.", category: "08" },
  { ar: "الاستشارات والخطط التسويقية", en: "Marketing consulting and strategy", detailAr: "جلسات وخطط عملية تبدأ من أهداف النشاط وميزانيته.", detailEn: "Practical sessions and plans shaped around goals and budget.", category: "09" },
];

const pageNames: Record<Section, { ar: string; en: string }> = {
  about: { ar: "عن أفق", en: "About Ofoq" }, services: { ar: "الخدمات", en: "Services" },
  howWeWork: { ar: "كيف نعمل", en: "How we work" }, whyOfoq: { ar: "لماذا أفق", en: "Why Ofoq" },
  work: { ar: "أعمالنا", en: "Our work" }, reviews: { ar: "تقييمات العملاء", en: "Client reviews" },
  faq: { ar: "الأسئلة الشائعة", en: "Frequently asked questions" }, contact: { ar: "تواصل معنا", en: "Contact us" },
};

export function MarketingInfoPage({ section, locale }: { section: Section; locale: Locale }) {
  const ar = locale === "ar";
  const d = dictionaries[locale];
  const current = pageNames[section];
  let lead = "";
  if (section === "about") lead = d.about.lead;
  if (section === "services") lead = d.services.lead;
  if (section === "howWeWork") lead = d.howWeWork.lead;
  if (section === "whyOfoq") lead = d.whyOfoq.lead;
  if (section === "work") lead = d.work.lead;
  if (section === "reviews") lead = d.reviews.lead;
  if (section === "faq") lead = ar ? "إجابات واضحة عن طريقة العمل والمنصة والتكاملات." : "Clear answers about the platform, our process and integrations.";
  if (section === "contact") lead = d.contact.lead;

  return (
    <main className="marketing-page">
      <header className="marketing-header">
        <Brand locale={locale} />
        <nav aria-label={ar ? "روابط الموقع" : "Website navigation"}>
          <a href="/about">{d.nav.about}</a><a href="/services">{d.nav.services}</a><a href="/how-we-work">{d.nav.howWeWork}</a><a href="/faq">{d.nav.faq}</a>
        </nav>
        <div className="marketing-actions"><LocaleSwitch locale={locale} /><a className="marketing-login" href="/login">{d.nav.login}</a><a className="marketing-cta" href="/register">{d.nav.register} <span aria-hidden="true">↗</span></a></div>
      </header>

      <div className="marketing-main">
        <div className="marketing-title-block"><span className="eyebrow">{ar ? "من العراق، برؤية عالمية" : "FROM IRAQ, WITH A GLOBAL OUTLOOK"}</span><h1>{current[ar ? "ar" : "en"]}<span>.</span></h1><p>{lead}</p></div>
        <section className="marketing-content">
          {section === "about" && <>
            <article className="marketing-feature"><span className="eyebrow">{d.about.storyTitle}</span><h2>{ar ? "نحو رؤية أبعد، بخطوات مفهومة." : "A wider horizon, with clear steps."}</h2><p>{d.about.story}</p></article>
            <div className="marketing-two-col"><article className="platform-card marketing-info-card"><h3>{d.about.valuesTitle}</h3><ul>{Object.values(d.about.values).map((item) => <li key={item.title}><strong>{item.title}</strong><span>{item.body}</span></li>)}</ul></article><article className="platform-card marketing-info-card"><h3>{d.about.aiTitle}</h3><p>{d.about.aiBody}</p><p className="marketing-honesty">{d.about.statusHonest}</p></article></div>
          </>}

          {section === "services" && <>
            <div className="marketing-service-grid">{services.map((service) => <article className="platform-card marketing-service-card" key={service.category}><span className="marketing-service-number">{service.category}</span><h2>{service[ar ? "ar" : "en"]}</h2><p>{service[ar ? "detailAr" : "detailEn"]}</p><a href="/register">{d.services.detailsCta} <span aria-hidden="true">↗</span></a></article>)}</div>
            <p className="marketing-honesty">{d.services.noBundle} {d.services.priceNote}</p>
          </>}

          {section === "howWeWork" && <>
            <div className="marketing-steps">{d.howWeWork.steps.map((step, index) => <article className="platform-card marketing-step" key={step.title}><span>{String(index + 1).padStart(2, "0")}</span><div><h2>{step.title}</h2><p>{step.body}</p></div></article>)}</div>
            <article className="marketing-policy"><span className="eyebrow">{d.howWeWork.policyTitle}</span><p>{d.howWeWork.policyBody}</p></article>
          </>}

          {section === "whyOfoq" && <>
            <div className="marketing-values-grid">{d.whyOfoq.points.map((point, index) => <article className="platform-card marketing-value-card" key={point.title}><span>{String(index + 1).padStart(2, "0")}</span><h2>{point.title}</h2><p>{point.body}</p></article>)}</div>
            <p className="marketing-honesty">{d.about.statusHonest}</p>
          </>}

          {section === "work" && <article className="marketing-empty"><span className="empty-state-mark">◇</span><h2>{ar ? "نشارك العمل الحقيقي فقط." : "We only share real work."}</h2><p>{d.work.empty}</p></article>}
          {section === "reviews" && <PublicReviews locale={locale} />}

          {section === "faq" && <div className="marketing-faq">{d.faq.items.map((item) => <details key={item.q}><summary>{item.q}<span aria-hidden="true">＋</span></summary><p>{item.a}</p></details>)}</div>}

          {section === "contact" && <div className="marketing-contact-grid"><article className="platform-card marketing-contact-card"><span className="eyebrow">{ar ? "محادثة قصيرة" : "A SHORT CONVERSATION"}</span><h2>{ar ? "أخبرنا بما تريد تحقيقه." : "Tell us what you want to achieve."}</h2><p>{ar ? "يمكنك إنشاء حساب والبدء مع مساعد أفق، أو مراسلة الفريق عبر البريد." : "Create an account and start with the Ofoq assistant, or reach the team by email."}</p><a className="button button-gold" href="/register">{d.nav.register} <span aria-hidden="true">↗</span></a></article><article className="platform-card marketing-contact-card"><span className="eyebrow">{ar ? "قناة التواصل" : "CONTACT CHANNEL"}</span><strong className="marketing-email">{ar ? "البريد المباشر غير مهيأ" : "Direct email is not configured"}</strong><p>{ar ? "ابدأ محادثة عبر المنصة؛ لا نعرض عنوانًا غير مؤكد." : "Start a conversation through the platform; no unverified address is shown."}</p><a className="text-link" href="/register">{ar ? "إنشاء حساب وبدء محادثة" : "Create an account to chat"} <span aria-hidden="true">↗</span></a></article></div>}
        </section>
      </div>
      <footer className="marketing-footer"><span>© {new Date().getFullYear()} أفق</span><span>{ar ? "منصة التسويق الذكي" : "Intelligent marketing platform"}</span><a href="/">{d.nav.home} ↗</a></footer>
    </main>
  );
}
