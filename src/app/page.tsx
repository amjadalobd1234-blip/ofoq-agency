const features = [
  {
    number: "01",
    title: "كل عميل في مكانه",
    description: "احتفظ بتفاصيل العملاء ومحادثاتهم واحتياجاتهم ضمن مساحة عمل واضحة لفريقك.",
    icon: "◈",
  },
  {
    number: "02",
    title: "مشاريع تسير بثقة",
    description: "نظّم المشاريع والعروض والخطوات القادمة، وتابع التقدم من دون أن تضيع التفاصيل.",
    icon: "↗",
  },
  {
    number: "03",
    title: "رؤية أوسع لأدائك",
    description: "اجمع الأنشطة والتنبيهات والتقارير لتعرف ما أُنجز وما يحتاج إلى اهتمامك.",
    icon: "◎",
  },
];

export default function HomePage() {
  return (
    <main className="site-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="أفق — الصفحة الرئيسية">
          <span className="brand-mark" aria-hidden="true">أ</span>
          <span className="brand-name">أفق<span>.</span></span>
        </a>

        <nav className="main-nav" aria-label="التنقل الرئيسي">
          <a href="#features">المزايا</a>
          <a href="#workflow">طريقة العمل</a>
        </nav>

        <a className="header-link" href="#features">
          اكتشف أفق <span aria-hidden="true">←</span>
        </a>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow"><span aria-hidden="true" /> مساحة واحدة لوكالتك الرقمية</p>
          <h1 id="hero-title">
            أعمال وكالتك،<br />
            <span>في أفقٍ واحد.</span>
          </h1>
          <p className="hero-description">
            من أول تواصل مع العميل إلى تسليم المشروع، أفق يساعدك على ترتيب التفاصيل
            ومتابعة العمل حتى يبقى تركيزك على النمو.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#features">
              تعرّف على المنصة <span aria-hidden="true">←</span>
            </a>
            <a className="text-link" href="#workflow">كيف يساعدك أفق؟</a>
          </div>
          <div className="hero-note">
            <span className="note-mark" aria-hidden="true">✦</span>
            <p>وضوح أكبر لفريقك، ومساحة أوسع لأفكارك.</p>
          </div>
        </div>

        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-sun" />
          <div className="art-card art-card-top">
            <span className="art-card-icon">↗</span>
            <span><strong>نظرة أوضح</strong><small>على يوم وكالتك</small></span>
          </div>
          <div className="art-card art-card-bottom">
            <span className="art-card-icon art-card-icon-light">✳</span>
            <span><strong>خطوة بخطوة</strong><small>من الفكرة إلى الإنجاز</small></span>
          </div>
          <div className="art-center">
            <span className="art-center-mark">أ</span>
            <span className="art-center-label">أفق</span>
          </div>
          <span className="art-spark spark-one">✳</span>
          <span className="art-spark spark-two">✦</span>
        </div>
      </section>

      <section className="features-section" id="features" aria-labelledby="features-title">
        <div className="section-heading">
          <p className="eyebrow">مساحة عمل متكاملة</p>
          <h2 id="features-title">رتّب التفاصيل. <span>وشاهد الصورة كاملة.</span></h2>
          <p>الأدوات الأساسية لإدارة وكالتك، مصممة لتعمل معاً بسلاسة.</p>
        </div>
        <div className="feature-grid">
          {features.map((feature) => (
            <article className="feature-card" key={feature.number}>
              <div className="feature-card-top">
                <span className="feature-icon" aria-hidden="true">{feature.icon}</span>
                <span className="feature-number">{feature.number}</span>
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-section" id="workflow" aria-labelledby="workflow-title">
        <div className="workflow-symbol" aria-hidden="true"><span>أ</span></div>
        <div>
          <p className="eyebrow">من يومك إلى وجهتك</p>
          <h2 id="workflow-title">عمل منظّم، <span>ونموّ يبدأ من هنا.</span></h2>
          <p>اجمع فريقك حول رؤية مشتركة، وامنح كل مشروع المساحة التي يستحقها.</p>
        </div>
        <a className="button button-light" href="#features">استكشف المزايا <span aria-hidden="true">←</span></a>
      </section>

      <footer className="site-footer">
        <a className="brand footer-brand" href="/" aria-label="أفق — الصفحة الرئيسية">
          <span className="brand-mark" aria-hidden="true">أ</span>
          <span className="brand-name">أفق<span>.</span></span>
        </a>
        <p>إدارة أسهل لوكالتك الرقمية.</p>
        <span className="footer-caption">© أفق</span>
      </footer>
    </main>
  );
}
