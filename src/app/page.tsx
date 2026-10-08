const services = [
  {
    number: "01",
    title: "الاستراتيجية والتموضع",
    description:
      "نكتشف ما يميّز علامتك ونحوّله إلى اتجاه واضح، ورسالة تصل إلى جمهورك في العراق وخارجه.",
    tags: ["بحث السوق", "استراتيجية العلامة", "خطة النمو"],
  },
  {
    number: "02",
    title: "الهوية وأنظمة التصميم",
    description:
      "هوية متفرّدة تبدأ من الفكرة، وتمنح علامتك حضوراً متماسكاً في كل نقطة تواصل.",
    tags: ["هوية بصرية", "أنظمة التصميم", "دليل العلامة"],
  },
  {
    number: "03",
    title: "المواقع والتجارب الرقمية",
    description:
      "تجارب رقمية أنيقة وسهلة الاستخدام، مصممة لتعمل بسلاسة على كل شاشة وتدعم أهدافك.",
    tags: ["تصميم المواقع", "تجربة المستخدم", "التطوير"],
  },
  {
    number: "04",
    title: "المحتوى والتسويق",
    description:
      "محتوى وحملات مدروسة تجمع بين صوت علامتك واحتياجات السوق لتصنع نمواً مستداماً.",
    tags: ["استراتيجية المحتوى", "الحملات", "إدارة القنوات"],
  },
];

const engagementModels = [
  {
    number: "01",
    name: "مشروع محدد",
    description: "للهوية أو الموقع أو أي مبادرة لها بداية ووجهة واضحتان.",
    price: "عرض سعر ثابت",
    detail: "يُحدّد بعد الاتفاق على نطاق العمل ومراحله.",
    featured: false,
  },
  {
    number: "02",
    name: "شراكة نمو",
    description: "لفريق يحتاج إلى خبرة إبداعية واستراتيجية مستمرة.",
    price: "اشتراك شهري مرن",
    detail: "يتناسب مع أولوياتك وحجم العمل المطلوب.",
    featured: true,
  },
  {
    number: "03",
    name: "جلسة استشارية",
    description: "لرؤية ثانية، أو خطة عملية، أو قرار يحتاج إلى وضوح.",
    price: "حسب نوع الجلسة",
    detail: "أجندة مركّزة ومخرجات واضحة قبل أن نبدأ.",
    featured: false,
  },
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

function GeometricArtwork() {
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
        <span>جذور عراقية</span>
      </div>
      <div className="art-label art-label-bottom">
        <span className="art-label-dot" />
        <span>رؤية بلا حدود</span>
      </div>
      <span className="art-coordinate art-coordinate-top">IRAQ · 33°N</span>
      <span className="art-coordinate art-coordinate-bottom">STRATEGY / DESIGN / GROWTH</span>
    </div>
  );
}

function SiteBrand({ footer = false }: { footer?: boolean }) {
  return (
    <a className={`brand${footer ? " brand-footer" : ""}`} href="#home" aria-label="أُفق — الصفحة الرئيسية">
      <BrandMark />
      <span className="brand-copy">
        <span className="brand-name">أُفق</span>
        <span className="brand-caption">CREATIVE STUDIO</span>
      </span>
    </a>
  );
}

export default function HomePage() {
  return (
    <main className="site-shell" id="home">
      <header className="site-header container">
        <SiteBrand />
        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <a href="#about">عن أفق</a>
          <a href="#services">الخدمات</a>
          <a href="#pricing">الأسعار</a>
          <a href="#contact">تواصل</a>
        </nav>
        <a className="header-cta" href="#contact">
          <span>لنبدأ حواراً</span>
          <ArrowIcon />
        </a>
      </header>

      <section className="hero container" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow hero-eyebrow"><span className="eyebrow-rule" /> وكالة إبداعية من العراق، للعالم</p>
          <h1 id="hero-title">
            أُفق<span className="title-period">.</span>
            <span className="hero-title-sub">نحو رؤيةٍ أبعد.</span>
          </h1>
          <p className="hero-description">
            نبني للعلامات الطموحة حضوراً يليق بأفكارها؛ باستراتيجية واعية، وتصميم متقن، وتجارب رقمية تبقى.
          </p>
          <div className="hero-actions">
            <a className="button button-gold" href="#contact">
              <span>ابدأ مشروعك</span>
              <ArrowIcon />
            </a>
            <a className="button-text" href="#services">
              اكتشف خدماتنا <span aria-hidden="true">←</span>
            </a>
          </div>
          <div className="hero-footnote">
            <span className="footnote-line" />
            <p>من بغداد، إلى كل مكان يستحق أن يراك.</p>
          </div>
        </div>

        <GeometricArtwork />

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
          <span>من نحن</span>
        </div>
        <div className="about-heading">
          <p className="eyebrow">عن أُفق</p>
          <h2 id="about-title">جذورٌ عراقية.<br /><span>رؤيةٌ عالمية.</span></h2>
        </div>
        <div className="about-copy">
          <p className="about-lead">نؤمن أن لكل فكرة أفقاً أوسع مما تراه الآن.</p>
          <p>
            أُفق استوديو إبداعي واستراتيجي يعمل مع العلامات التي تريد أن تنمو بثقة. نمزج فهماً عميقاً للسياق المحلي بمعايير عمل عالمية، لنحوّل الطموح إلى قصة واضحة وتجربة متكاملة وأثر ملموس.
          </p>
          <div className="about-signature">
            <span className="signature-mark" aria-hidden="true">✳</span>
            <span><small>بوصلتنا</small><strong>وضوحٌ في الفكرة. أثرٌ في كل خطوة.</strong></span>
          </div>
        </div>
      </section>

      <section className="services-section" id="services" aria-labelledby="services-title">
        <div className="container">
          <div className="section-heading section-heading-split">
            <div>
              <p className="eyebrow">02 <span className="eyebrow-divider">/</span> ما نقدّمه</p>
              <h2 id="services-title">من الرؤية <span>إلى الأثر.</span></h2>
            </div>
            <p className="section-intro">
              خدمات مترابطة، تُصمَّم حول احتياجك وتعمل معاً لتصنع للعلامة حضوراً لا يُنسى.
            </p>
          </div>
          <div className="service-grid">
            {services.map((service) => (
              <article className="service-card" key={service.number}>
                <div className="service-card-top">
                  <span className="service-number">{service.number}</span>
                  <span className="service-ornament" aria-hidden="true"><span /><span /><span /></span>
                </div>
                <h3>{service.title}</h3>
                <p>{service.description}</p>
                <ul className="service-tags" aria-label={`مجالات ${service.title}`}>
                  {service.tags.map((tag) => <li key={tag}>{tag}</li>)}
                </ul>
                <a className="service-link" href="#contact" aria-label={`ناقش ${service.title} مع أفق`}>
                  <span>ناقش احتياجك</span><ArrowIcon />
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="pricing-section container" id="pricing" aria-labelledby="pricing-title">
        <div className="pricing-heading">
          <p className="eyebrow">03 <span className="eyebrow-divider">/</span> الأسعار</p>
          <h2 id="pricing-title">شراكة واضحة.<br /><span>وقيمة تستحقها.</span></h2>
          <p>
            لا أسعار مخفية ولا باقات مفروضة. نحدّد نطاق العمل معك أولاً، ثم نقدّم عرضاً واضحاً قبل أي التزام.
          </p>
          <div className="pricing-promise"><span aria-hidden="true">✳</span> وضوح من أول محادثة، حتى آخر تسليم.</div>
        </div>
        <div className="pricing-options">
          {engagementModels.map((model) => (
            <article className={`pricing-card${model.featured ? " pricing-card-featured" : ""}`} key={model.number}>
              <div className="pricing-card-top">
                <span className="pricing-number">{model.number}</span>
                {model.featured && <span className="recommended-label">الأكثر مرونة</span>}
              </div>
              <h3>{model.name}</h3>
              <p className="pricing-description">{model.description}</p>
              <div className="price-divider" />
              <span className="price-label">آلية التسعير</span>
              <strong className="price-value">{model.price}</strong>
              <p className="price-detail">{model.detail}</p>
              <a className="pricing-link" href="#contact">
                <span>اطلب عرضاً مناسباً</span><ArrowIcon />
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
            <p className="eyebrow">04 <span className="eyebrow-divider">/</span> الخطوة التالية</p>
            <h2 id="contact-title">لِنرسم أفقك<br /><span>القادم معاً.</span></h2>
            <p>حدثنا عن فكرتك. نبدأ بحوار صريح، ونعود إليك بخطوة واضحة تناسب طموحك.</p>
          </div>
          <div className="contact-action">
            <a className="button button-gold contact-button" href="mailto:hello@ofaq.com">
              <span>راسل فريق أُفق</span><ArrowIcon />
            </a>
            <a className="contact-email" href="mailto:hello@ofaq.com">hello@ofaq.com</a>
            <span className="contact-reach">العراق <span>·</span> الشرق الأوسط <span>·</span> العالم</span>
          </div>
        </div>
      </section>

      <footer className="site-footer container">
        <SiteBrand footer />
        <div className="footer-links" aria-label="روابط سريعة">
          <a href="#about">عن أفق</a>
          <a href="#services">الخدمات</a>
          <a href="#pricing">الأسعار</a>
          <a href="#contact">تواصل</a>
        </div>
        <p className="footer-copyright">© {new Date().getFullYear()} أُفق. صُنِع بفكرٍ عراقي.</p>
      </footer>
    </main>
  );
}
