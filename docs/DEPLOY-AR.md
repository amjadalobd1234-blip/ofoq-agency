# تشغيل ونشر منصة أفق على Supabase وNetlify

تستخدم واجهات تسجيل الدخول والبوابة والمحادثة الجديدة **Supabase Auth** عبر `@supabase/ssr` و**Supabase Data API / PostgREST** عبر HTTPS. لا يحتاج تشغيل هذه الواجهات إلى `DATABASE_URL` أو كلمة مرور PostgreSQL أو مفتاح `service_role`.

## 1. إعداد مخطط Supabase

المستودع يضم مخطط الوكالة الحالي (35 جدول تطبيق + جدول تتبّع الترحيلات = 36 جدولًا) وملفًا إضافيًا يربط Auth بملف العميل ويضيف سياسات RLS وإجراءات REST الآمنة.

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
| `APP_URL` | رابط نشر الموقع الفعلي، مثل `https://اسم-الموقع.netlify.app` |
| `APP_DOMAIN` | اختياري؛ اتركه فارغًا حتى اختيار نطاق تملكه وربطه فعليًا |
| `GEMINI_API_KEY` | اختياري؛ مفتاح Gemini على الخادم لتوليد ردود `/api/chat` |
| `GEMINI_MODEL` | اختياري؛ الافتراضي `gemini-2.0-flash` |

انسخ `.env.example` إلى `.env` للتطوير المحلي. عند غياب Gemini يعمل مساعد أفق بردود قواعد محلية واضحة ولا يدّعي وجود مزود AI فعّال. لا تضع `GEMINI_API_KEY` ضمن متغيرات `NEXT_PUBLIC_*`.

**لا تضف** `SUPABASE_SERVICE_ROLE_KEY` أو `DATABASE_URL` إلى واجهات المتصفح. لا يحتاج العميل إلى بيانات بطاقة؛ الدفع الإلكتروني غير مفعّل حاليًا، والفواتير اليدوية فقط ظاهرة كحالة غير مفعّلة.

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

- **Gemini:** اختياري؛ لا توجد مكالمات خارجية عند غياب المفتاح.
- **Google Ads:** البنية الحالية غير متصلة بحساب إعلاني. لا توجد حملات أو أرقام مفترضة.
- **WhatsApp Business:** معطل حتى ربط حساب رسمي.
- **الدفع:** فواتير ومسار يدوي فقط؛ لا تُعالج البطاقات ولا تخزّن.
- **البريد:** التحقق واستعادة كلمة المرور يعتمدان إعدادات Auth لدى Supabase؛ مزوّد البريد الإضافي في خدمة الوكالة منفصل.

## 7. ملاحظة حول طبقة البيانات السابقة

يحتفظ المستودع بطبقة SQLite وخدمات الوكالة الحالية للتطوير المحلي والتوافق مع أدواتها. صفحات Auth/بوابة العميل/المحادثة الجديدة تستخدم Supabase REST فقط عند إعداد `NEXT_PUBLIC_SUPABASE_*`. لا تشغّل موصل PostgreSQL `pg` من Arena ولا تضع رابط قاعدة البيانات في متغيرات النشر لهذه الواجهات.
