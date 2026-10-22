# أفق | Ofoq

منصة تسويق رقمي بهوية عراقية، تضم الموقع التعريفي، حسابات العملاء، بوابة المشاريع، محادثة «مساعد أفق»، ولوحة المالك والشريك. الواجهة داكنة بالأسود والذهبي والنحاس، وتدعم العربية RTL والإنجليزية LTR.

## تشغيل محلي

```bash
npm install
cp .env.example .env
# أضف رابط Supabase ومفتاح anon العام إلى .env
npm run dev
```

افتح `http://localhost:3000`. إعدادات Supabase المطلوبة للبوابة والمحادثة:

```dotenv
NEXT_PUBLIC_SUPABASE_URL="https://<project-ref>.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="<public-anon-or-publishable-key>"
```

لا تضع `service_role` أو `DATABASE_URL` أو مفاتيح Gemini في كود المتصفح. تصفح الصفحات العامة ممكن دون Supabase، وتعرض صفحات المنصة تنبيه إعداد واضحًا حتى تضاف الإعدادات.

## إعداد Supabase ونشر Netlify

اقرأ [دليل النشر العربي](docs/DEPLOY-AR.md)، ثم نفّذ `docs/setup/supabase-setup.sql` في Supabase SQL Editor. وعند تعذّر ظهور بيانات التنبيهات رغم أنها تعمل في SQL: [تفاصيل التنبيه والتشخيص](docs/ADMIN-ALERTS-AR.md) و`GET /api/debug/alerts`. طلب الخدمة الموجّه في الدردشة (الحفظ كتنبيه `NEW_REQUEST`، بيانات واتساب، تعديل الميزانية، وحالة `DRAFT` المؤقتة): [طلبات الخدمة](docs/SERVICE-REQUESTS-AR.md). وكيل إدارة المشاريع (إنشاء المشروع، الخطة والمراحل، الاعتماد، نسبة الإنجاز، التنبيهات، الإغلاق): [وكيل إدارة المشاريع](docs/PROJECTS-AGENT-AR.md). وكيل الإعلانات (خطة استشارية، اعتماد المالك، نتائج يدوية، بلا إطلاق أو إنفاق): [وكيل الإعلانات](docs/ADS-AGENT-AR.md). يستخدم التطبيق Supabase Auth وData API عبر HTTPS مع RLS/RPC؛ لا يحتاج نشر الواجهة الجديدة إلى اتصال PostgreSQL مباشر.

## المسارات الرئيسية

- `/` الموقع التعريفي.
- `/login` تسجيل الدخول بالبريد أو Google عند تفعيل المزود.
- `/register` إنشاء حساب والتحقق من البريد.
- `/dashboard` بوابة العميل.
- `/chat` محادثة مساعد أفق.
- `/admin` ملخص تشغيلي للمالك والشريك، محمي بالدور (قراءة فقط في هذه المرحلة).
- `/api/chat` واجهة المحادثة؛ تحفظ الرسائل في `conversations` و`messages` وتستخدم Gemini عند إعداد المفتاح.

## اختبارات وفحوص

```bash
npm run typecheck
npm test
npm run build
```

## حالة التكاملات

Gemini اختياري، وGoogle Ads وWhatsApp غير مربوطين افتراضيًا، والدفع الإلكتروني غير مفعّل (الفواتير اليدوية فقط). لا تُعرض بيانات عملاء أو أعمال أو نتائج وهمية. راجع `.env.example` و`docs/DEPLOY-AR.md` لإكمال التهيئة.
