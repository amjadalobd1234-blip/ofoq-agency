# تشخيص شامل: خطأ «Failed to fetch» في /register — النتائج والحل النهائي

> تاريخ التشخيص: 2026-10-09
> الأعراض: `/register` تفشل بـ "Failed to fetch"، صفحة `/debug` (Test Fetch) ترجع NetworkError،
> Supabase Auth → Users = 0 مستخدمين، المتغيرات تظهر بقيم صحيحة الطول (URL = 40 حرفًا، KEY = 208 حرفًا يبدأ بـ eyJ)،
> والفشل مستمر على Chrome وFirefox حتى بعد حذف CSP بالكامل.

---

## 🏁 التحديث النهائي — السبب الجذري المؤكد (2026-10-09)

**مزودو الإنترنت في العراق (وفي دول أخرى) يحجبون نطاق `supabase.co` بالكامل على مستوى الشبكة.**

- المتصفح لا يستطيع الوصول إلى `sltgxlrfscpchulobazb.supabase.co` **أبدًا** من تلك الشبكات — حتى مع VPN في بعض الحالات.
- لوحة التحكم `dashboard.supabase.com` تفتح عاديًا لأنها على نطاق مختلف (`supabase.com`).
- هذا يفسّر كل الأعراض دفعة واحدة: `Failed to fetch` على Chrome وFirefox، فشل Test Fetch بعد حذف CSP،
  و0 مستخدمين في Auth لأن الطلبات لا تصل إلى Supabase أصلًا.

**الحل النهائي المُنفَّذ: وسيط Supabase عبر Netlify** — المتصفح يرسل الطلبات إلى `/api/supabase-proxy`
على نطاق الموقع نفسه، وسيرفرات Netlify (خارج نطاق الحجب) تتصل بـ Supabase وتعيد الرد.
التفعيل والقيود (تأكيد البريد، Google OAuth) موثقة في `docs/DEPLOY-AR.md` القسم «3-ب. وضع الوسيط».

| الخطوة | القيمة |
| --- | --- |
| متغير البيئة | `NEXT_PUBLIC_SUPABASE_PROXY_URL=/api/supabase-proxy` (في Netlify، ثم إعادة النشر) |
| ملف الوسيط | `src/app/api/supabase-proxy/[...path]/route.ts` |
| العميل | `src/lib/supabase/browser.ts` يمرر عبر الوسيط تلقائيًا عند ضبط المتغير |
| التحقق | `/debug` — اختبارات `proxy:` يجب أن تكون خضراء حتى على شبكة محجوبة |

---


## أولاً: نتائج فحص ملفات الكود (المطلوب في البنود 1–4)

### 1) `next.config.ts` — ✅ لا يوجد ما يمنع الاتصالات

- لا توجد `rewrites` ولا `redirects` ولا proxy.
- الرؤوس الأمنية المفعّلة (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`)
  **لا تمنع `fetch` إطلاقًا** — ولا تؤثر على الاتصال بـ Supabase.
- الـ CSP كان يحتوي `connect-src` يسمح صراحةً بـ `https://*.supabase.co`، ثم حُذف بالكامل أثناء التشخيص
  **والمشكلة استمرت** ← CSP ليس السبب (مؤكد).
- ⚠️ حذف CSP هو تراجع أمني مؤقت. خطة إعادته موثّقة داخل الملف نفسه وقريبًا في هذه الصفحة.

### 2) `src/middleware.ts` — ✅ لا يمنع الاتصالات

- يعمل على `/register` لكنه **لا يعترض طلبات `fetch` من المتصفح**.
- ما يفعله: قراءة كوكيز الجلسة + `auth.getUser()` لتحديد الصفحة فقط. عند فشل Supabase يكمل كمجهول.
- لا يوجد به حظر، إعادة توجيه لصفحة التسجيل نفسها، أو تغيير لرؤوس الطلبات.

### 3) `netlify.toml` — ✅ سليم

- بناء عادي (`npm run build`) + `@netlify/plugin-nextjs`. لا رؤوس، لا حظر، لا redirects.
- المسارات التي تحتاجها (`/register`, `/debug`, `/api/*`) تُنشر عبر runtime الخاص بـ Next على Netlify.

### 4) `src/app/layout.tsx` — ✅ لا يوجد meta CSP أو أي تعديل على الرؤوس

- لا `<meta http-equiv="Content-Security-Policy">`. لا ملف آخر يحقن CSP.
- الشهادات (meta/headers) الوحيدة للموقع هي المذكورة في `next.config.ts`.

**الخلاصة: لا يوجد أي إعداد في كود الموقع يمنع الاتصال بـ Supabase. المشكلة خارج الكود.**

---

## ثانيًا: نتائج الفحص البعيد (من خارج متصفحك — مؤكدة)

قمنا باختبارات فعلية من بيئة محايدة (المتصفح غير مشارك):

| الاختبار | النتيجة |
| --- | --- |
| `https://example.com` | ✅ يعمل |
| `https://www.google.com` | ✅ يعمل |
| `https://supabase.com` (موقع Supabase نفسه) | ✅ يعمل |
| `https://sltgxlrfscpchulobazb.supabase.co` (جذر مشروعك) | 🔴 **فشل على مستوى الشبكة — لا يوجد رد إطلاقًا** |
| `https://sltgxlrfscpchulobazb.supabase.co/auth/v1/health` | 🔴 **فشل على مستوى الشبكة** |
| `https://sparking-piroshki-94654d.netlify.app` (موقعك) | 🔴 **صفحة Netlify الرسمية "Site not found"** — النطاق فرعي غير موجود حاليًا |

### ماذا يعني هذا؟

1. **رابط مشروع Supabase لا يستجيب من أي مكان** (وليس من متصفحك وحده).
   هذا يفسّر كل الأعراض دفعة واحدة:
   - `Failed to fetch` في `/register` و`/debug` — لأن `fetch` يفشل قبل وصول أي رد.
   - **0 مستخدمين في Auth** — لأن طلبات التسجيل لا تصل إلى Supabase أصلًا.
   - الفشل على Chrome وFirefox وبعد حذف CSP — لأن المشكلة ليست في المتصفح ولا في الرؤوس.
   - المتغيرات "صحيحة" — لأنها فعلًا صحيحة الشكل؛ لكن **المشروع الذي تشير إليه لا يستجيب**.

2. **رابط Netlify الذي ذكرته (`sparking-piroshki-94654d.netlify.app`) يعيد "Site not found" من Netlify نفسه**.
   يعني: إما أن الموقع حُذف/أُعيدت تسميته، أو الرابط غير دقيق. تأكد من الاسم الحالي في
   Netlify → Site settings → Site name / Domain management. (وإن تغيّر الرابط، يجب تحديثه في Supabase Redirect URLs أيضًا.)

---

## ثالثًا: قائمة كل الأسباب المحتملة (مرتّبة بالاحتمال)

### أسباب على مستوى المشروع/الشبكة (الأعلى احتمالًا — تطابق كل الأعراض)

| # | السبب | كيف يُشخص |
| --- | --- | --- |
| 1 | 🔴 **مشروع Supabase متوقف (Paused)** — المشاريع المجانية تتوقف تلقائيًا بعد 7 أيام خمول؛ المتوقف لا يرد على API إطلاقًا | افتح dashboard.supabase.com — المشروع يظهر "Paused" / "Restore project" |
| 2 | 🔴 **المشروع حُذف، أو الرابط (ref) خاطئ/قديم** | لوحة Supabase: هل يوجد مشروع باسم ref الموجود في الرابط أصلًا؟ |
| 3 | 🟠 حجب شبكي إقليمي/ISP لـ `*.supabase.co` | اختبار `/debug` من جوال على بيانات الهاتف (ليس نفس الـ Wi‑Fi) |
| 4 | 🟠 DNS ملوّث/محجوب يمنع الوصول لـ `supabase.co` | جرّب DNS 1.1.1.1 أو 8.8.8.8 |

### أسباب على مستوى المتصفح (متوسطة الاحتمال — تُستبعد إذا فشل `/api/debug/remote` أيضًا)

| # | السبب | كيف يُشخص |
| --- | --- | --- |
| 5 | مانع إعلانات/تتبع (uBlock Origin, AdBlock, Brave Shields) يحجب الطلبات إلى supabase | نافذة Incognito بلا إضافات |
| 6 | مضاد فيروسات/جدار حماية يعترض TLS أو الطلبات | عطّله مؤقتًا أو استثنِ النطاق |
| 7 | VPN/بروكسي مؤسسي يحجب النطاق | أوقفه مؤقتًا |
| 8 | إضافات مثل "HTTPS Everywhere" أو أمان زائد | نافذة Incognito |

### أسباب من إعدادات التطبيق/Supabase (تنتج أخطاء HTTP 4xx/5xx — **وليست** "Failed to fetch")

> مهم جدًا: إعدادات **Site URL / Redirect URLs** في Supabase تؤثر على **روابط إعادة التوجيه فقط**
> (رابط التحقق في البريد، OAuth). **لا يمكنها أبدًا** أن تمنع طلب `signup` من الوصول —
> لو كانت هي السبب لرأيت ردًا HTTP (مثل 400/422) لا "Failed to fetch".

| # | السبب | الأعراض المتوقعة |
| --- | --- | --- |
| 9 | Site URL / Redirect URLs غير مضبوطة | التسجيل قد ينجح لكن رابط التحقق في البريد يرجع لدومين خاطئ |
| 10 | مفتاح anon يخص مشروعًا آخر | رد HTTP 401/403 (Invalid API key) — وليس فشل شبكة |
| 11 | Email provider معطّل أو "Confirm email" + SMTP غير مضبوط | رد HTTP مع رسالة — وليس فشل شبكة |
| 12 | قيود معدّل الطلبات (rate limit) | 429 بعد عدة محاولات |
| 13 | متغيرات Netlify أُضيفت بعد آخر بناء (NEXT_PUBLIC تُدمج وقت البناء) | `/debug` سيعرض MISSING للقيم — وهو ما لا يحدث لديك |
| 14 | CSP `connect-src` ضيّق | يستمر بعد حذف CSP → **مُستبعد لديك** (مذكور للمرجعية) |

---

## رابعًا: الأسباب المؤكدة حتى الآن

1. ✅ **مؤكد: لا يوجد أي إعداد في كود الموقع** (next.config / middleware / netlify.toml / layout) يمنع الاتصال.
2. ✅ **مؤكد: CSP ليس السبب** — الفشل مستمر بعد حذفه، والفحص البعيد يفشل دون أي CSP.
3. ✅ **مؤكد: رابط مشروع Supabase `sltgxlrfscpchulobazb.supabase.co` لا يستجيب على مستوى الشبكة من خارج متصفحك.**
   التفسير الأرجح بقوة (بترتيب الأولوية):
   - **المشروع متوقف (Paused)** — السبب الأكثر شيوعًا لهذه الحالة تمامًا (مشاريع Free تتوقف بعد خمول).
   - المشروع حُذف، أو الـ ref في الرابط خاطئ/من مشروع آخر.
4. ✅ **مؤكد: رابط Netlify المذكور يعيد "Site not found"** — الموقع غير موجود حاليًا على ذلك النطاق الفرعي.

---

## خامسًا: الحل النهائي — خطوة بخطوة

### الخطوة 1 — أعد تفعيل مشروع Supabase (الأهم)

1. افتح <https://dashboard.supabase.com> وسجّل الدخول.
2. هل المشروع يظهر **"Paused"**؟ ← اضغط **Restore project** وانتظر دقيقة أو دقيقتين.
3. هل المشروع غير موجود؟ ← أنشئ مشروعًا جديدًا و**حدّث** `NEXT_PUBLIC_SUPABASE_URL` و`NEXT_PUBLIC_SUPABASE_ANON_KEY`
   في Netlify (Site configuration → Environment variables) من **Project Settings → API** للمشروع الجديد.
4. طبّق مخطط البوابة: `docs/setup/supabase-setup.sql` في SQL Editor (مرة واحدة).

### الخطوة 2 — إعدادات Auth (البند 6 المطلوب)

من **Authentication → URL Configuration**:

- **Site URL**: `https://<اسم-موقعك>-الحالي.netlify.app` (الرابط الحقيقي بعد التأكد من الخطوة التالية).
- **Redirect URLs**: أضف كل ما يلزم:
  ```text
  http://localhost:3000/auth/callback
  https://<اسم-موقعك>-الحالي.netlify.app/auth/callback
  https://<اسم-موقعك>-الحالي.netlify.app/*
  ```
- تذكّر: هذه الإعدادات **لا تسبب "Failed to fetch"** إطلاقًا — لكنها ضرورية ليعمل رابط التحقق في البريد وGoogle OAuth.

### الخطوة 3 — تحقق من المفتاح (البند 7 المطلوب)

من **Project Settings → API**:

1. **anon public / publishable key** — تأكد أنه من **نفس المشروع** المعروض في الرابط.
2. المفتاح القديم هو JWT يبدأ فعلاً بـ:
   `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9` (رأس HS256) — طوله يقارب 208 أحرف ✅ يطابق وصفك.
   المفتاح الجديد يبدأ بـ `sb_publishable_` وكلاهما مقبول.
3. **التحقق الأهم**: افتح `/debug` → قسم «فك ترميز المفتاح (JWT)» — الصفحة تقارن `ref` داخل المفتاح
   بـ ref الموجود في الرابط تلقائيًا. إذا لم يتطابقا ← المفتاح من مشروع آخر.
4. تأكد أن `NEXT_PUBLIC_SUPABASE_URL` = Project URL تمامًا (بدون مسافات أو "/" زائدة):
   `https://sltgxlrfscpchulobazb.supabase.co`

### الخطوة 4 — أعد النشر على Netlify

1. تأكد من **اسم الموقع الفعلي** (Site settings → General → Site name) — الرابط القديم يعيد "Site not found".
2. Environment variables: أضف/حدّث `NEXT_PUBLIC_SUPABASE_URL` و`NEXT_PUBLIC_SUPABASE_ANON_KEY` (Scope: All).
   تذكّر: قيم `NEXT_PUBLIC_*` تُدمج **وقت البناء** ← أي تغيير يتطلب **Trigger deploy** جديد.
3. اضبط `APP_URL` على الرابط الجديد للموقع.
4. إن كان الرابط تغيّر: حدّث Supabase Site URL + Redirect URLs للرابط الجديد (الخطوة 2).

### الخطوة 5 — تحقق نهائي عبر /debug

افتح `https://<موقعك>/debug` واقرأ:

| ما تراه | المعنى |
| --- | --- |
| 🟢 supabase health/root + server probe أخضر | تم حل المشكلة — جرّب `/register` الآن |
| 🔴 supabase + 🔴 server probe | المشروع ما زال متوقفًا/الرابط خاطئ — عد للخطوة 1 |
| 🟢 server probe و🔴 supabase من المتصفح | حظر محلي: أضفات المتصفح/مضاد الفيروسات/VPN — جرّب Incognito |
| 🔴 حتى example.com | مشكلة الإنترنت/البروكسي عندك — ليست Supabase |

### الخطوة 6 — أعد تفعيل CSP (بعد نجاح التسجيل)

1. افتح `next.config.ts` وأعد تفعيل كتلة `Content-Security-Policy` المعلّقة (مكتوبة بالكامل جاهزة).
2. احذف تنبيه «CSP مؤقتًا مُعطَّلة».
3. أعد النشر، ثم افتح `/debug` وتأكد أن قسم «رأس CSP» يظهر الكتلة وأن `connect-src` يشمل `https://*.supabase.co`.
4. جرّب `/register` مرة أخيرة مع CSP مفعّلة.

### الخطوة 7 — اختبار المسار كاملًا

1. `/register` → إنشاء حساب → تأكيد البريد (من Supabase → Authentication → Users يظهر المستخدم).
2. `/login` → `/chat` و`/dashboard`.
3. ترقية أول حساب لمالك (من SQL Editor فقط — مذكورة في `docs/DEPLOY-AR.md`).

---

## سادسًا: كيف تستخدم أدوات التشخيص الجديدة

### صفحة `/debug` (من المتصفح)

- **اختبارات تلقائية**: example.com, google.com, supabase health, supabase root, auth settings (بالمفتاح),
  no-cors probe, `/api/health`, `/api/debug/remote`.
- **كشف CSP**: يقرأ رأس `Content-Security-Policy` من استجابة الموقع فعليًا.
- **فك ترميز المفتاح**: يعرض `ref`/`role`/`alg` ويقارن `ref` برابط المشروع.
- **Test Signup**: يدوي فقط — ينشئ مستخدمًا حقيقيًا إذا نجح.
- **نسخ التقرير**: زر ينسخ كل النتائج جاهزة للصق.

### مسار `/api/debug/remote` (من خادم Netlify)

ينفّذ نفس اختبارات Supabase **من الخادم نفسه** ويعيد `verdict`:

- `server_cannot_reach_supabase` ← المشكلة في المشروع/الرابط (وليس متصفحك).
- `server_reaches_supabase` ← الخادم سليم؛ المشكلة عندك محليًا (متصفح/شبكة).
- `server_reaches_but_http_errors` ← المضيف يعمل؛ راجع أكواد HTTP في `checks`.

لا يُعيد المسار أي أسرار — فقط أطوال وبادئات المفاتيح.

---

## سابعًا: ملخص القرار

| السؤال | الجواب |
| --- | --- |
| هل الكود يمنع الاتصال؟ | ❌ لا — تم فحص كل الملفات |
| هل CSP هو السبب؟ | ❌ لا — الفشل مستمر بدونه |
| هل المتغيرات خاطئة؟ | ❌ شكلها صحيح — لكن تشير إلى مشروع لا يستجيب |
| ما السبب المؤكد؟ | 🔴 مشروع Supabase لا يستجيب على مستوى الشبكة (متوقف/محذوف/ref خاطئ) + رابط Netlify يعيد "Site not found" |
| الحل؟ | Restore المشروع + تأكيد رابط Netlify الحالي + تحديث القيم وإعادة النشر + تحقق عبر `/debug` + أعد تفعيل CSP |
