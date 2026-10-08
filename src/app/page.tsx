import { getLocale } from "@/lib/i18n";
import { LocaleSwitch } from "@/components/locale-switch";

const services = [
  {
    number: "01", title: "الاستراتيجية والتموضع", titleEn: "Strategy and positioning",
    description: "نكتشف ما يميّز علامتك ونحوّله إلى اتجاه واضح، ورسالة تصل إلى جمهورك في العراق وخارجه.",
    descriptionEn: "We turn what makes your brand different into a clear direction and a message for your audience in Iraq and beyond.",
    tags: ["بحث السوق", "استراتيجية العلامة", "خطة النمو"], tagsEn: ["Market research", "Brand strategy", "Growth plan"],
  },
  {
    number: "02", title: "الهوية وأنظمة التصميم", titleEn: "Identity and design systems",
    description: "هوية متفرّدة تبدأ من الفكرة، وتمنح علامتك حضوراً متماسكاً في كل نقطة تواصل.",
    descriptionEn: "A distinctive identity built from an idea, giving your brand a coherent presence at every touchpoint.",
    tags: ["هوية بصرية", "أنظمة التصميم", "دليل العلامة"], tagsEn: ["Visual identity", "Design systems", "Brand guidelines"],
  },
  {
    number: "03", title: "المواقع والتجارب الرقمية", titleEn: "Websites and digital experiences",
    description: "تجارب رقمية أنيقة وسهلة الاستخدام، مصممة لتعمل بسلاسة على كل شاشة وتدعم أهدافك.",
    descriptionEn: "Elegant, accessible digital experiences designed to work across screens and support your goals.",
    tags: ["تصميم المواقع", "تجربة المستخدم", "التطوير"], tagsEn: ["Web design", "User experience", "Development"],
  },
  {
    number: "04", title: "المحتوى والتسويق", titleEn: "Content and marketing",
    description: "محتوى وحملات مدروسة تجمع بين صوت علامتك واحتياجات السوق لتصنع نمواً مستداماً.",
    descriptionEn: "Thoughtful content and campaigns that connect your brand voice with market needs.",
    tags: ["استراتيجية المحتوى", "الحملات", "إدارة القنوات"], tagsEn: ["Content strategy", "Campaigns", "Channel management"],
  },
];

const engagementModels = [
  { number: "01", name: "مشروع محدد", nameEn: "Defined project", description: "للهوية أو الموقع أو أي مبادرة لها بداية ووجهة واضحتان.", descriptionEn: "For a brand, website or initiative with a clear start and finish.", price: "عرض سعر ثابت", priceEn: "Fixed project quote", detail: "يُحدّد بعد الاتفاق على نطاق العمل ومراحله.", detailEn: "Set after agreeing the scope and milestones.", featured: false },
  { number: "02", name: "شراكة نمو", nameEn: "Growth partnership", description: "لفريق يحتاج إلى خبرة إبداعية واستراتيجية مستمرة.", descriptionEn: "For a team that needs ongoing creative and strategic support.", price: "اشتراك شهري مرن", priceEn: "Flexible monthly retainer", detail: "يتناسب مع أولوياتك وحجم العمل المطلوب.", detailEn: "Shaped around your priorities and scope.", featured: true },
  { number: "03", name: "جلسة استشارية", nameEn: "Consulting session", description: "لرؤية ثانية، أو خطة عملية، أو قرار يحتاج إلى وضوح.", descriptionEn: "For an outside perspective, a practical plan or a decision that needs clarity.", price: "حسب نوع الجلسة", priceEn: "Scoped to the session", detail: "أجندة مركّزة ومخرجات واضحة قبل أن نبدأ.", detailEn: "A focused agenda and clear outputs agreed in advance.", featured: false },
];

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4.5 15.5 15 5M5.5 5H15v9.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <path d="M22 2.75 41.25 22 22 41.25 2.75 22 22 2.75Z" stroke="currentColor" strokeWidth="1.15" />
      <path d="M22 9.5 34.5 22 22 34.5 9.5 22 22 9.5Z" stroke="currentColor" strokeWidth="1.15" />
      <path d="M22 15v14M15 22h14" stroke="currentColor" strokeWidth="1.15" />
      <circle cx="22" cy="22" r="2.1" fill="currentColor" />
    </svg>
  );
}

function GeometricArtwork({ locale }: { locale: "ar" | "en" }) {
  return (
    <div className="hero-artwork" aria-hidden="true">
      <svg className="geometry-svg" viewBox="0 0 560 560" fill="none">
        <defs>
          <pattern id="ofoq-geometry-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <path d="M14 0v28M0 14h28" stroke="#D4AF37" strokeOpacity=".18" strokeWidth=".65" />
            <path d="m14 5 9 9-9 9-9-9 9-9Z" stroke="#D4AF37" strokeOpacity=".15" strokeWidth=".65" />
            <circle cx="14" cy="14" r="1.1" fill="#F5D76E" fillOpacity=".45" />
          </pattern>
          <radialGradient id="ofoq-center-glow">
            <stop stopColor="#D4AF37" stopOpacity=".19" />
            <stop offset="1" stopColor="#D4AF37" stopOpacity="0" />
          </radialGradient>
          <clipPath id="ofoq-center-clip">
            <circle cx="280" cy="280" r="166" />
          </clipPath>
        </defs>
        <circle cx="280" cy="280" r="205" fill="url(#ofoq-center-glow)" />
        <circle cx="280" cy="280" r="224" stroke="#D4AF37" strokeOpacity=".22" />
        <circle cx="280" cy="280" r="194" stroke="#F5D76E" strokeOpacity=".32" strokeDasharray="1 7" />
        <circle cx="280" cy="280" r="166" stroke="#D4AF37" strokeOpacity=".2" />
        <rect x="162" y="162" width="236" height="236" fill="url(#ofoq-geometry-grid)" clipPath="url(#ofoq-center-clip)" opacity=".6" />
        <rect x="175" y="175" width="210" height="210" rx="15" stroke="#D4AF37" strokeOpacity=".54" transform="rotate(45 280 280)" />
        <rect x="204" y="204" width="152" height="152" rx="12" stroke="#F5D76E" strokeOpacity=".42" transform="rotate(45 280 280)" />
        <path d="m280 146 24 82 82 24-82 24-24 82-24-82-82-24 82-24 24-82Z" stroke="#D4AF37" strokeOpacity=".48" strokeWidth="1.1" />
        <circle cx="280" cy="280" r="91" stroke="#F5D76E" strokeOpacity=".62" />
        <circle cx="280" cy="280" r="73" stroke="#D4AF37" strokeOpacity=".24" strokeDasharray="2 6" />
        <path d="M280 82v36m0 324v36M82 280h36m324 0h36" stroke="#D4AF37" strokeOpacity=".53" />
        <path d="m142 142 25 25m226 226 25 25m0-276-25 25M167 393l-25 25" stroke="#F5D76E" strokeOpacity=".55" />
        <circle cx="280" cy="56" r="3" fill="#F5D76E" />
        <circle cx="504" cy="280" r="3" fill="#F5D76E" />
        <circle cx="280" cy="504" r="3" fill="#F5D76E" />
        <circle cx="56" cy="280" r="3" fill="#F5D76E" />
      </svg>
      <div className="hero-seal">
        <span className="hero-seal-mark">أ</span>
        <span className="hero-seal-name">أُفق</span>
        <span className="hero-seal-caption">IDEAS INTO IMPACT</span>
      </div>
      <div className="art-label art-label-top">
        <span className="art-label-index">01</span>
        <span>{locale === "ar" ? "جذور عراقية" : "Iraqi roots"}</span>
      </div>
      <div className="art-label art-label-bottom">
        <span className="art-label-dot" />
        <span>{locale === "ar" ? "رؤية بلا حدود" : "A wider horizon"}</span>
      </div>
      <span className="art-coordinate art-coordinate-top">IRAQ · MENA</span>
      <span className="art-coordinate art-coordinate-bottom">STRATEGY / DESIGN / GROWTH</span>
    </div>
  );
}

function SiteBrand({ footer = false, locale }: { footer?: boolean; locale: "ar" | "en" }) {
  return (
    <a className={`brand${footer ? " brand-footer" : ""}`} href="#home" aria-label={locale === "ar" ? "أفق — الصفحة الرئيسية" : "Ofoq — home"}>
      <BrandMark />
      <span className="brand-copy">
        <span className="brand-name">أُفق</span>
          <span className="brand-caption">{locale === "ar" ? "منصة التسويق الذكي" : "INTELLIGENT MARKETING PLATFORM"}</span>
      </span>
    </a>
  );
}

export default async function HomePage() {
  const locale = await getLocale();
  const ar = locale === "ar";
  return (
    <main className="site-shell" id="home">
      <header className="site-header container">
        <SiteBrand locale={locale} />
        <nav className="main-nav" aria-label={ar ? "التنقل الرئيسي" : "Main navigation"}>
          <a href="/about">{ar ? "عن أفق" : "About"}</a>
          <a href="/services">{ar ? "الخدمات" : "Services"}</a>
          <a href="#pricing">{ar ? "الأسعار" : "Pricing"}</a>
          <a href="/contact">{ar ? "تواصل" : "Contact"}</a>
        </nav>
        <div className="header-actions">
          <LocaleSwitch locale={locale} />
          <a className="header-login" href="/login">{ar ? "تسجيل دخول" : "Sign in"}</a>
          <a className="header-cta" href="/register" aria-label={ar ? "لنبدأ حواراً — إنشاء حساب" : "Start a conversation — create an account"}>
            <span>{ar ? "لنبدأ حواراً" : "Start a conversation"}</span>
            <ArrowIcon />
          </a>
        </div>
      </header>

      <section className="hero container" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow hero-eyebrow"><span className="eyebrow-rule" /> {ar ? "منصة تسويق رقمي من العراق، للعالم" : "A digital marketing platform from Iraq, for the world"}</p>
          <h1 id="hero-title">
            أُفق<span className="title-period">.</span>
            <span className="hero-title-sub">{ar ? "نحو رؤيةٍ أبعد." : "A wider horizon."}</span>
          </h1>
          <p className="hero-description">
            {ar ? "نبني للعلامات الطموحة حضوراً يليق بأفكارها؛ باستراتيجية واعية، وتصميم متقن، وتجارب رقمية تبقى." : "We help ambitious brands build a presence that matches their ideas — with thoughtful strategy, considered design and lasting digital experiences."}
          </p>
          <div className="hero-actions">
            <a className="button button-gold" href="/register">
              <span>{ar ? "ابدأ مشروعك" : "Start your project"}</span>
              <ArrowIcon />
            </a>
            <a className="button-text" href="/services">
              {ar ? "اكتشف خدماتنا" : "Explore our services"} <span aria-hidden="true">←</span>
            </a>
          </div>
          <div className="hero-footnote">
            <span className="footnote-line" />
            <p>{ar ? "من العراق، إلى كل مكان يستحق أن يراك." : "From Iraq, to every place ready to see you."}</p>
          </div>
        </div>

        <GeometricArtwork locale={locale} />

        <div className="hero-side-note" aria-hidden="true">
          <span>OFOQ — 2026</span>
          <span className="side-note-line" />
          <span>BUILT FOR WHAT&apos;S NEXT</span>
        </div>
      </section>

      <section className="about-section container" id="about" aria-labelledby="about-title">
        <div className="section-index" aria-hidden="true">
          <span>01</span>
          <span className="index-rule" />
          <span>{ar ? "من نحن" : "ABOUT"}</span>
        </div>
        <div className="about-heading">
          <p className="eyebrow">{ar ? "عن أفق" : "ABOUT OFOQ"}</p>
          <h2 id="about-title">{ar ? <>جذورٌ عراقية.<br /><span>رؤيةٌ عالمية.</span></> : <>Iraqi roots.<br /><span>A global outlook.</span></>}</h2>
        </div>
        <div className="about-copy">
          <p className="about-lead">{ar ? "نؤمن أن لكل فكرة أفقاً أوسع مما تراه الآن." : "We believe every idea has a wider horizon than it can see today."}</p>
          <p>
            {ar ? "أفق منصة تسويق رقمي تعمل مع العلامات التي تريد أن تنمو بثقة. نمزج فهماً عميقاً للسياق المحلي بمعايير عمل عالمية، لنحوّل الطموح إلى خطة واضحة وتجربة متكاملة وأثر ملموس." : "Ofoq is a digital marketing platform for brands ready to grow with confidence. We bring local context together with global standards to turn ambition into a clear plan, a coherent experience and meaningful impact."}
          </p>
          <div className="about-signature">
            <span className="signature-mark" aria-hidden="true">✳</span>
            <span><small>{ar ? "بوصلتنا" : "OUR COMPASS"}</small><strong>{ar ? "وضوحٌ في الفكرة. أثرٌ في كل خطوة." : "Clarity in every idea. Impact in every step."}</strong></span>
          </div>
        </div>
      </section>

      <section className="services-section" id="services" aria-labelledby="services-title">
        <div className="container">
          <div className="section-heading section-heading-split">
            <div>
              <p className="eyebrow">02 <span className="eyebrow-divider">/</span> {ar ? "ما نقدّمه" : "WHAT WE DO"}</p>
              <h2 id="services-title">{ar ? <>من الرؤية <span>إلى الأثر.</span></> : <>From vision <span>to impact.</span></>}</h2>
            </div>
            <p className="section-intro">
              {ar ? "خدمات مترابطة، تُصمَّم حول احتياجك وتعمل معاً لتصنع للعلامة حضوراً لا يُنسى." : "Connected services shaped around your needs, working together to build a memorable brand presence."}
            </p>
          </div>
          <div className="service-grid">
            {services.map((service) => (
              <article className="service-card" key={service.number}>
                <div className="service-card-top">
                  <span className="service-number">{service.number}</span>
                  <span className="service-ornament" aria-hidden="true"><span /><span /><span /></span>
                </div>
                <h3>{ar ? service.title : service.titleEn}</h3>
                <p>{ar ? service.description : service.descriptionEn}</p>
                <ul className="service-tags" aria-label={ar ? `مجالات ${service.title}` : `${service.titleEn} areas`}>
                  {(ar ? service.tags : service.tagsEn).map((tag) => <li key={tag}>{tag}</li>)}
                </ul>
                <a className="service-link" href="/register" aria-label={ar ? `ناقش ${service.title} مع أفق` : `Discuss ${service.titleEn} with Ofoq`}>
                  <span>{ar ? "ناقش احتياجك" : "Discuss your needs"}</span><ArrowIcon />
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="pricing-section container" id="pricing" aria-labelledby="pricing-title">
        <div className="pricing-heading">
          <p className="eyebrow">03 <span className="eyebrow-divider">/</span> {ar ? "الأسعار" : "PRICING"}</p>
          <h2 id="pricing-title">{ar ? <>شراكة واضحة.<br /><span>وقيمة تستحقها.</span></> : <>A clear partnership.<br /><span>Value you can see.</span></>}</h2>
          <p>
            {ar ? "لا أسعار مخفية ولا باقات مفروضة. نحدّد نطاق العمل معك أولاً، ثم نقدّم عرضاً واضحاً قبل أي التزام." : "No hidden prices or forced bundles. We agree on the scope first, then share a clear proposal before you commit."}
          </p>
          <div className="pricing-promise"><span aria-hidden="true">✳</span> {ar ? "وضوح من أول محادثة، حتى آخر تسليم." : "Clarity from the first conversation to delivery."}</div>
        </div>
        <div className="pricing-options">
          {engagementModels.map((model) => (
            <article className={`pricing-card${model.featured ? " pricing-card-featured" : ""}`} key={model.number}>
              <div className="pricing-card-top">
                <span className="pricing-number">{model.number}</span>
                {model.featured && <span className="recommended-label">{ar ? "الأكثر مرونة" : "MOST FLEXIBLE"}</span>}
              </div>
              <h3>{ar ? model.name : model.nameEn}</h3>
              <p className="pricing-description">{ar ? model.description : model.descriptionEn}</p>
              <div className="price-divider" />
              <span className="price-label">{ar ? "آلية التسعير" : "PRICING MODEL"}</span>
              <strong className="price-value">{ar ? model.price : model.priceEn}</strong>
              <p className="price-detail">{ar ? model.detail : model.detailEn}</p>
              <a className="pricing-link" href="/register">
                <span>{ar ? "اطلب عرضاً مناسباً" : "Request a proposal"}</span><ArrowIcon />
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="contact-section container" id="contact" aria-labelledby="contact-title">
        <div className="contact-panel">
          <div className="contact-pattern" aria-hidden="true">
            <svg viewBox="0 0 360 360" fill="none">
              <defs>
                <pattern id="contact-pattern-grid" width="32" height="32" patternUnits="userSpaceOnUse">
                  <path d="M16 0v32M0 16h32M5 5l22 22m0-22L5 27" stroke="#F5D76E" strokeOpacity=".3" strokeWidth=".55" />
                  <circle cx="16" cy="16" r="1.2" fill="#D4AF37" fillOpacity=".7" />
                </pattern>
              </defs>
              <rect width="360" height="360" fill="url(#contact-pattern-grid)" />
              <circle cx="180" cy="180" r="116" stroke="#F5D76E" strokeOpacity=".5" />
              <rect x="96" y="96" width="168" height="168" rx="9" stroke="#F5D76E" strokeOpacity=".55" transform="rotate(45 180 180)" />
            </svg>
          </div>
          <div className="contact-copy">
            <p className="eyebrow">04 <span className="eyebrow-divider">/</span> {ar ? "الخطوة التالية" : "NEXT STEP"}</p>
            <h2 id="contact-title">{ar ? <>لِنرسم أفقك<br /><span>القادم معاً.</span></> : <>Let’s shape your<br /><span>next horizon.</span></>}</h2>
            <p>{ar ? "حدثنا عن فكرتك. ابدأ بحوار صريح، وسنساعدك على توضيح الخطوة التالية." : "Tell us about your idea. Start an honest conversation and we can help clarify the next step."}</p>
          </div>
          <div className="contact-action">
            <a className="button button-gold contact-button" href="/register">
              <span>{ar ? "ابدأ محادثة" : "Start a conversation"}</span><ArrowIcon />
            </a>
            <span className="contact-email">{ar ? "لا يوجد بريد دعم مهيأ بعد" : "No support email is configured yet"}</span>
            <span className="contact-reach">{ar ? <>العراق <span>·</span> الشرق الأوسط <span>·</span> العالم</> : <>Iraq <span>·</span> Middle East <span>·</span> Worldwide</>}</span>
          </div>
        </div>
      </section>

      <footer className="site-footer container">
        <SiteBrand footer locale={locale} />
        <div className="footer-links" aria-label={ar ? "روابط سريعة" : "Quick links"}>
          <a href="/about">{ar ? "عن أفق" : "About"}</a>
          <a href="/services">{ar ? "الخدمات" : "Services"}</a>
          <a href="#pricing">{ar ? "الأسعار" : "Pricing"}</a>
          <a href="/contact">{ar ? "تواصل" : "Contact"}</a>
        </div>
        <p className="footer-copyright">© {new Date().getFullYear()} {ar ? "أفق. صُنِع بفكرٍ عراقي." : "Ofoq. Built with an Iraqi perspective."}</p>
      </footer>
    </main>
  );
}
