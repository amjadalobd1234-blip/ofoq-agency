# تشغيل ونشر منصة أفق على Supabase وNetlify

تستخدم واجهات تسجيل الدخول والبوابة والمحادثة الجديدة **Supabase Auth** عبر `@supabase/ssr` و**Supabase Data API / PostgREST** عبر HTTPS. لا يحتاج تشغيل هذه الواجهات إلى `DATABASE_URL` أو كلمة مرور PostgreSQL أو مفتاح `service_role`.

## 1. إعداد مخطط Supabase

المستودع يضم مخطط الوكالة الحالي (35 جدول تطبيق + جدول تتبّع الترحيلات + جدول سجل استخدام الذكاء الاصطناعي `ai_usage` = 37 جدولًا) وملفات إضافية تربط Auth بملف العميل وتضيف سياسات RLS وإجراءات REST الآمنة.

1. افتح مشروع Supabase ثم **SQL Editor**.
2. افتح `docs/setup/supabase-setup.sql` من المستودع وانسخ محتواه كاملًا.
3. نفّذه مرة واحدة في SQL Editor بصلاحية مالك قاعدة البيانات.
4. لا تستخدم `npm run db:migrate` أو رابط قاعدة البيانات لهذا الإعداد. ملف SQL يشمل جداول المشروع وإعداد Auth/RLS، وهو مصمم لإعادة التشغيل الآمن.

الترحيل `db/migrations/supabase/0001_auth_portal.sql` يضيف:

- إنشاء صفّ `users` وصفّ `customers` تلقائيًا بعد إنشاء مستخدم Supabase Auth.
- دور `CLIENT` افتراضيًا؛ لا يستطيع العميل تعيين نفسه مالكًا أو شريكًا.
- منع الوصول المباشر إلى جداول التشغيل عبر anon/authenticated، مع قراءة محدودة لملف المستخدم نفسه.
- RPCs آمنة لبوابة العميل، لوحة المالك/الشريك، التقييمات المنشورة، والمحادثات.
- حفظ رسائل العميل وردود مساعد أفق في جدولي `conversations` و`messages` الحاليين.
- `db/migrations/supabase/0002_ai_usage.sql`: جدول سجل استخدام مزودي الذكاء الاصطناعي مع RPC للكتابة `ofoq_ai_usage_record` وRPC للمالك فقط `ofoq_ai_usage_admin`.
- `db/migrations/supabase/0003_escalation_alerts.sql`: التصعيد الفعلي لمساعد أفق.
  - `ofoq_client_escalate`: ينشئ صف `alerts` (severity `URGENT`/`IMPORTANT`، category `HUMAN_REQUEST`/`NEW_LEAD`، `entity_type='conversation'`، `target_role='ANY_STAFF'`، `status='NEW'`)، ويحوّل المحادثة إلى `PENDING`، ويكتب إشعارات `IN_APP` و`EMAIL` لكل مالك/شريك فعّال، ويسجّل الحدث في `activities`.
  - `ofoq_escalation_email_result`: يسجّل هل وصل بريد المالك فعلًا (SENT/FAILED) حتى لا يبقى الفشل صامتًا.
  - منع التكرار: تنبيه واحد لكل محادثة/تصنيف/يوم عبر `dedupe_key`، والتنبيه المُغلق يُعاد فتحه عند طلب العميل مرة أخرى.
  - `ofoq_admin_dashboard` أصبح يعيد `leadRequests` و`totals.newLeads` و`totals.criticalAlerts`، ويحسب `urgentAlerts` من `URGENT` و`IMPORTANT` معًا.
- `db/migrations/supabase/0004_escalation_owner_support.sql`: التصعيد يعمل لأي حساب مسجّل (المالك والشريك مشمولان).
  - `ofoq_ensure_customer_profile` (مضاف إلى `0001`): ينشئ صفّ `customers` الناقص للحساب عند أول محادثة، فلا يبقى حساب بلا صفّ عميل.
  - ترميم لمرة واحدة لكل الحسابات التي لا تملك صفّ عميل.
  - `ofoq_client_escalate`: تُحلّ المحادثة أولًا، وأي `OWNER`/`PARTNER` فعّال يصعّد أي محادثة ويب، و`alerts.customer_id` قد يكون `NULL` مع بقاء التنبيه، ورسائل الرفض مفصّلة، والنتيجة تحمل كتلة `identity`.
  - سياسة إدخال `alerts_insert_authenticated` (RLS) مضيّقة إلى صفوف التصعيد فقط، مع بقاء صلاحية الجدول مسحوبة.
  - `ofoq_escalation_diagnostics`: RPC لتشخيص فشل التصعيد، مربوط بـ `GET /api/debug/escalation` وقسم 8 في `/debug`.
  - التفاصيل وخطوات الاختبار في `docs/ESCALATION-AR.md`.
- `db/migrations/supabase/0006_escalate_manual_overload.sql`: نسخة مختصرة للاستخدام اليدوي.
  - `public.ofoq_client_escalate(p_conversation_id, p_reason, p_summary, p_severity)` تُقبل الآن
    بأربعة وسائط أيضًا — وهي **غلاف** يسند التسلسل إلى الدالة الأصلية بتسعة وسائط، فلا يوجد إلا
    كاتب واحد لجدول `alerts` (منع التكرار، `PENDING`، الإشعارات، `activities` كلها تبقى في مسار واحد).
  - التطبيق نفسه **لا يتغير**: يستمر في استدعاء الدالة بتسعة وسائط
    (`p_conversation_id, p_category, p_severity, p_title_ar, p_title_en, p_body_ar, p_body_en, p_reason, p_signals`).
  - لا تمنح هذه الملف أي صلاحية على الجداول، ولا تعتمد على `GRANT` المباشر الذي أُضيف تجريبيًا على
    المشروع الحي: الدالة `SECURITY DEFINER` وتكتب `alerts` بصلاحية المالك.
  - في SQL Editor لا توجد جلسة مستخدم، لذا يجب ضبط `request.jwt.claims` قبل الاختبار اليدوي —
    الرد `Authentication required` يعني أن الفحص يعمل، لا أن هناك خللًا جديدًا.
- `db/migrations/supabase/0007_admin_alerts.sql`: مركز التنبيهات التفاعلي للفريق.
  - القائمة `/admin/alerts` والتفاصيل `/admin/alerts/[id]` تستخدم إجراءات `ofoq_admin_alerts` و`ofoq_admin_alert_details` فقط؛ لا توجد قراءة مباشرة من المتصفح لجداول التنبيهات أو المحادثات.
  - إجراءات `ofoq_admin_acknowledge_alert` و`ofoq_admin_resolve_alert` و`ofoq_admin_reply_to_client` تتحقق من دور `OWNER`/`PARTNER` داخل قاعدة البيانات، وتسجل صاحب الإجراء في `activities`.
  - رد الفريق يُحفظ كرسالة `STAFF` في نفس المحادثة ويزيد تنبيهات العميل؛ لا يمكن الرد على تنبيه غير مرتبط بمحادثة عميل.
  - الملف يفحص نفسه عند التطبيق: تقرير قبل التثبيت وبعده، ثم `NOTIFY pgrst, 'reload schema';` في النهاية —
    لأن الدالة قد تكون موجودة في SQL Editor وغير مرئية للـ Data API (خطأ `PGRST202`) حتى تُعاد قراءة ذاكرة PostgREST المؤقتة.
  - إجراء الـ middleware يشمل الآن `/api/admin/:path*` (و`/api/me` و`/api/dashboard`) ليجدّد جلسة Supabase قبل أن يقرأها أي route.
  - التشخيص الكامل (لماذا لا تصل بيانات التنبيه) في `docs/ADMIN-ALERTS-AR.md`، ومن المتصفح: `GET /api/debug/alerts` بعد تسجيل الدخول.
- عزل سجلات العميل عبر التحقق من `auth.uid()` داخل كل RPC. لا تُعاد التكاليف الداخلية أو الملاحظات الداخلية إلى بوابة العميل.

> لا يتصل هذا الإعداد بقاعدة البيانات من Arena. نفّذ SQL يدويًا في لوحة Supabase فقط، ثم يطلب التطبيق البيانات عبر HTTPS وRLS.

## 2. إعداد Supabase Auth

من **Authentication → URL Configuration** أضف عناوين إعادة التوجيه إلى **Redirect URLs**، مثل:

```text
http://localhost:3000/auth/callback
https://اسم-الموقع.netlify.app/auth/callback
https://نطاقك-إن-وجد/auth/callback
```

اترك **Confirm email** مفعّلًا في الإنتاج، وأضف مزود بريد موثوقًا لإرسال رابط التحقق واستعادة كلمة المرور. بعد التسجيل يذهب العميل إلى محادثة «مساعد أفق» مباشرة بعد التحقق.

### تسجيل Google الاختياري

فعّل Google من **Authentication → Providers → Google** فقط بعد إعداد OAuth Client في Google Cloud. سجّل عنوان callback الذي تعرضه Supabase في Google Cloud، وأضف عناوين Netlify والمحلي في Supabase Redirect URLs. لا يختلق المشروع مفاتيح Google ولا يفعّل المزود تلقائيًا.

### ترقية حساب المالك الأول

أنشئ حساب المالك من `/register` وتحقق من البريد. بعد ذلك، من SQL Editor في Supabase فقط، رقِّ الحساب يدويًا (استبدل البريد بقيمة حسابك):

```sql
UPDATE public.users
SET role = 'OWNER', status = 'ACTIVE', updated_at = now()::text
WHERE lower(email) = lower('owner@example.com');
```

يمكن تكرار ذلك للشريك مع `role = 'PARTNER'`. لا توجد واجهة عامة تسمح برفع صلاحيات المستخدم.

## 3. متغيرات البيئة

أضف المتغيرات من إعدادات Netlify، لا إلى Git. القيم العامة التالية لا تحتوي أسرارًا خاصة بقاعدة البيانات:

| المتغير | الاستخدام |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | رابط مشروع Supabase من Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | المفتاح العام `anon`/publishable فقط؛ تمنع RLS الوصول غير المصرح |
| `NEXT_PUBLIC_SUPABASE_PROXY_URL` | اختياري — اضبطها على `/api/supabase-proxy` في الشبكات التي يحجب فيها مزود الخدمة نطاق `*.supabase.co` (العراق وغيرها)؛ المتصفح يمر حينها عبر وسيط Netlify |
| `APP_URL` | رابط نشر الموقع الفعلي، مثل `https://اسم-الموقع.netlify.app` |
| `APP_DOMAIN` | اختياري؛ اتركه فارغًا حتى اختيار نطاق تملكه وربطه فعليًا |
| `GROQ_API_KEY` | مزود الذكاء الاصطناعي الأول (الأسرع) — حد 14,400/يوم |
| `GEMINI_API_KEY` | مزود ثانٍ عبر وضع التوافق مع OpenAI — حد 1,500/يوم |
| `NVIDIA_API_KEY` | مزود ثالث (NVIDIA NIM) — حد 40/دقيقة |
| `COHERE_API_KEY` | مزود رابع (الأفضل للعربية، يُقدَّم تلقائيًا للرسائل العربية) — حد 1,000/شهر |
| `OPENROUTER_API_KEY` | مزود خامس (موديلات مجانية كخط أخير) — حد 50/يوم |
| `RESEND_API_KEY` | اختياري؛ إرسال قوالب الإيميل (ترحيب/عرض/فاتورة/تنبيه/تحويل بشري) من `src/lib/email/email-service.ts` |
| `OWNER_EMAIL` | من يستقبل بريد التصعيد (بفاصلة بين العناوين) إضافة إلى حسابات OWNER/PARTNER الفعّالة. عند تركه فارغًا يُستخدم عنوان المالك الافتراضي الموثّق في `src/lib/services/escalation.service.ts` |

في **Cloudflare Pages** تُضاف هذه المتغيرات من **Settings → Variables and Secrets** بنفس الأسماء تمامًا (GROQ_API_KEY، GEMINI_API_KEY، NVIDIA_API_KEY، COHERE_API_KEY، OPENROUTER_API_KEY، RESEND_API_KEY). لا تحتاج إلى إعادة بناء الكود بعد إضافتها، ولا تضع أي مفتاح بصيغة `NEXT_PUBLIC_*`.

انسخ `.env.example` إلى `.env` للتطوير المحلي. لا مفتاح إلزامي: عند غياب كل مزودي الذكاء الاصطناعي يعمل مساعد أفق بردود قواعد محلية واضحة ولا يدّعي وجود مزود فعّال، وعند غياب `RESEND_API_KEY` تُجهَّز رسائل الإيميل وتُسجَّل في سجل الخادم بدل إرسالها.

### سلسلة المزودين ولوحة التكاملات

- الترتيب والحدود والموديلات معرّفة في `src/lib/ai/providers.ts`، والاستدعاء الموحّد في `src/lib/ai/ai-service.ts` (OpenAI SDK واحد لكل المزودين).
- عند `429` أو انتهاء المهلة (30 ثانية) أو خطأ `5xx` أو مفتاح مفقود ينتقل الطلب تلقائيًا إلى المزود التالي، ثم إلى القواعد المحلية إن فشل الجميع.
- كل محاولة تُسجَّل في `public.ai_usage` (تُنشأ عبر `db/migrations/supabase/0002_ai_usage.sql`، وهي مضمّنة أيضًا في `docs/setup/supabase-setup.sql`).
- الصفحة `/admin/settings/integrations` للمالك فقط: تعرض 🟢/🔴 لكل مزود، والاستخدام اليومي، وزر «اختبار»، وآخر 10 طلبات. لا تُرسل أي مفاتيح إلى المتصفح، بل أسماء المتغيرات فقط.

**لا تضف** `SUPABASE_SERVICE_ROLE_KEY` أو `DATABASE_URL` إلى واجهات المتصفح. لا يحتاج العميل إلى بيانات بطاقة؛ الدفع الإلكتروني غير مفعّل حاليًا، والفواتير اليدوية فقط ظاهرة كحالة غير مفعّلة.

## 3-ج. واجهات إدارة المشاريع (Projects API) — متطلب `DATABASE_URL`

بوابة العميل وواجهات Auth/المحادثة تعمل عبر Supabase REST فقط ولا تحتاج أي سر قاعدة
بيانات. أما **واجهات إدارة المشاريع** (`/api/projects*`: إنشاء مشروع، اعتماد خطة، تحديث
مهمة، إغلاق، مراقبة) فهي تعمل على محرّك البيانات المحلي في المستودع، أي تحتاج قاعدة
بيانات حقيقية في الإنتاج.

**ما هو متاح اليوم في إعدادات الإنتاج:** `NEXT_PUBLIC_SUPABASE_URL` و
`NEXT_PUBLIC_SUPABASE_ANON_KEY` فقط. **لا يوجد `DATABASE_URL` في الإعدادات الحالية**،
ولن يضيفه هذا المستودع تلقائيًا — هو إعداد خارجي يُنفَّذ من قِبل المالك.

**ما يجب ضبطه (Netlify: Environment variables / Cloudflare Pages: Variables and Secrets):**

| المتغير | القيمة | ملاحظة |
| --- | --- | --- |
| `DATABASE_DRIVER` | `postgres` | إلزامي مع `DATABASE_URL`؛ بدونه يستخدم التطبيق المخزن المحلي |
| `DATABASE_URL` | رابط اتصال مشروع Supabase (سر) | من Project Settings → Database → Connection string (السلسلة المباشرة أو الـ pooler) مع `sslmode=require` |

مثال الشكل (القيم الحقيقية من لوحة Supabase، ولا تُنشر في Git):

```text
DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require
```

**خطوات التفعيل (من قِبل المالك، خارج هذا الـ PR):**

1. ضبط `DATABASE_DRIVER=postgres` و`DATABASE_URL` كسر في إعدادات النشر.
2. تطبيق ترحيلات Postgres على نفس القاعدة:
   ```bash
   DATABASE_DRIVER=postgres DATABASE_URL="<the same secret>" npm run db:migrate
   ```
   (المولَّد: `npm run db:generate-postgres` — ينتج `db/migrations/postgres/*.sql`).
3. تطبيق ترحيل Supabase `db/migrations/supabase/0011_project_plans.sql` يدويًا في
   SQL Editor (لم يُطبَّق من هذا المستودع).

**سلوك التطبيق在没有 هذا الإعداد:** لا يوجد سقوط صامت. عند غياب `DATABASE_URL` مع
`DATABASE_DRIVER=postgres` تردّ المسارات بـ `503` ورمز `CONFIGURATION_ERROR` ورسالة تذكر
المتغيّر المطلوب؛ وإذا كان المخزن المحلي غير قابل للفتح (نشر بلا قرص دائم) تردّ المسارات
بـ `503` أيضًا بدل خطأ `500` مبهم أو — وهو الأخطر — الكتابة في قاعدة محلية معزولة
والاعتقاد بأننا نعمل على قاعدة الإنتاج.

**ما يعمل بدون `DATABASE_URL`:** بوابة العميل (تقدّم المشروع، الخطة المعتمدة، المراحل)
تقرأ `ofoq_client_dashboard()` من Supabase عبر HTTPS، وتعرض الخطة المعتمدة بعد تطبيق
ترحيل 0011. أما إنشاء/اعتماد/إغلاق مشروع من لوحة الإدارة فيحتاج `DATABASE_URL`.

## 3-ب. وضع الوسيط — تجاوز حجب `*.supabase.co` (العراق ودول أخرى)

يستخدم بعض مزودي الإنترنت حجبًا على مستوى الشبكة لنطاق `supabase.co` بالكامل (بينما يبقى نطاق لوحة التحكم `supabase.com` متاحًا). النتيجة: `Failed to fetch` في التسجيل والدخول من تلك الشبكات حتى مع تطبيق سليم وإعدادات صحيحة.

الحل المدمج: **وسيط عبر Netlify** في `src/app/api/supabase-proxy/[...path]/route.ts`.
المتصفح يرسل طلبات Supabase إلى نفس نطاق الموقع (`/api/supabase-proxy/auth/v1/...`)، وسيرفرات Netlify (خارج نطاق الحجب) تمرر الطلب إلى مشروع Supabase وتعيد الرد.

**التفعيل:**

1. أضف المتغير في Netlify (Site configuration → Environment variables):
   ```text
   NEXT_PUBLIC_SUPABASE_PROXY_URL=/api/supabase-proxy
   ```
2. أعد النشر (قيم `NEXT_PUBLIC_*` تُدمج وقت البناء).
3. افتح `/debug` — يجب أن يظهر: اختبارات supabase المباشرة ممكن أن تفشل على شبكتك، بينما اختبارات `proxy:` كلها خضراء 🟢.

هذا الإعداد **اختياري**: في بيئات لا يوجد فيها حجب، اتركه فارغًا فيتحدث المتصفح مع Supabase مباشرة. الخادم (middleware ومسارات API) يتصل مع Supabase دائمًا بشكل مباشر ولا يتأثر بالوسيط.

**القيود المهمة:**

- **تأكيد البريد (Confirm email):** رابط التحقق الافتراضي يشير إلى `*.supabase.co` مباشرة وهو محجوب في تلك الشبكات. الخيارات:
  - أبسط حل: عطّل **Confirm email** من Authentication → Providers → Email، فيُنشأ الجلسة فور التسجيل عبر الوسيط. (مناسب للبوابات الداخلية.)
  - أو استخدم قالب بريد يمرر الرابط عبر الوسيط — من Authentication → Email Templates ضع:
    ```html
    <a href="https://اسم-موقعك.netlify.app/api/supabase-proxy/auth/v1/verify?token={{ .Token }}&amp;type={{ .Type }}&amp;redirect_to={{ .RedirectTo }}">
      تأكيد الحساب
    </a>
    ```
  - أو فعّل Supabase Custom Domains (مدفوع) ليصبح نطاق Auth خاصًا بك وغير محجوب.
- **تسجيل Google:** مسار OAuth يمر بنقّال متصفح إلى `supabase.co` في منتصف الرحلة (Google → callback على المشروع) ولا يعمل عبر وسيط HTTP. البريد وكلمة المرور يعملان كاملَيْن عبر الوسيط. Google يتطلب إما شبكة غير محجوبة أو نطاق Auth مخصص.
- **Realtime (WebSocket):** لا يمر عبر الوسيط. هذا المشروع لا يستخدم Realtime حاليًا.
- **الملفات الكبيرة (Storage):** رفع الملفات الكبيرة عبر الوسيط محدود بحدود دوال Netlify؛ الرفع الصغير يعمل.

## 4. النشر على Netlify

1. اربط المستودع في Netlify؛ إعدادات البناء موجودة في `netlify.toml` وتستخدم `@netlify/plugin-nextjs`.
2. أضف متغيرات البيئة أعلاه إلى إعدادات الموقع، ثم أعد النشر.
3. افتح `/api/health`. عند ضبط Supabase يفحص المسار نقطة Auth عبر HTTPS ولا يكشف المفاتيح. في بيئة الإنتاج، غياب الإعداد يظهر الحالة `degraded` مع HTTP 503 بدل الإيحاء بأن بوابة العميل جاهزة.
4. اختبر `/register`، رسالة التحقق، `/login`، ثم `/chat` و`/dashboard`. جرّب `/admin` بحساب OWNER أو PARTNER فقط.

## 5. التشغيل والاختبارات

```bash
npm install
cp .env.example .env
# املأ NEXT_PUBLIC_SUPABASE_URL وNEXT_PUBLIC_SUPABASE_ANON_KEY محليًا
npm run dev
```

افتح `http://localhost:3000`. قبل النشر شغّل:

```bash
npm run typecheck
npm test
npm run build
```

تحتاج صفحات المنصة إلى قيم Supabase وملف SQL حتى تعمل المصادقة والبيانات؛ من دونها تعرض حالة إعداد واضحة، ولا تنشئ بيانات تجريبية.

## 6. التكاملات غير المفعّلة

- **مزودو الذكاء الاصطناعي (Groq / Gemini / NVIDIA / Cohere / OpenRouter):** اختيارية جميعًا؛ لا توجد مكالمات خارجية عند غياب المفاتيح، ومساعد أفق يعمل بالقواعد المحلية.
- **Resend:** اختياري؛ بدون مفتاح تُجهَّز الرسائل وتُسجَّل فقط.
- **Google Ads:** البنية الحالية غير متصلة بحساب إعلاني. لا توجد حملات أو أرقام مفترضة.
- **WhatsApp Business:** معطل حتى ربط حساب رسمي.
- **الدفع:** فواتير ومسار يدوي فقط؛ لا تُعالج البطاقات ولا تخزّن.
- **البريد:** التحقق واستعادة كلمة المرور يعتمدان إعدادات Auth لدى Supabase؛ مزوّد البريد الإضافي في خدمة الوكالة منفصل.

## 7. ملاحظة حول طبقة البيانات السابقة

يحتفظ المستودع بطبقة SQLite وخدمات الوكالة الحالية للتطوير المحلي والتوافق مع أدواتها. صفحات Auth/بوابة العميل/المحادثة الجديدة تستخدم Supabase REST فقط عند إعداد `NEXT_PUBLIC_SUPABASE_*`. لا تشغّل موصل PostgreSQL `pg` من Arena ولا تضع رابط قاعدة البيانات في متغيرات النشر لهذه الواجهات.

**استثناء واحد (مطلوب من المالك):** واجهات إدارة المشاريع (`/api/projects*`) تحتاج قاعدة PostgreSQL حقيقية في الإنتاج — راجع §3-ج. هذا الاستثناء متعلق بواجهات الإدارة (الكتابة على المشاريع)، ولا يمس بوابة العميل التي تقرأ Supabase عبر RPC دون أي سر.
