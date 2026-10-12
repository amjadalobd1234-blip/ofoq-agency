# تفاصيل التنبيه: لماذا لا تصل بيانات الـ RPC — التشخيص والإصلاح

> تاريخ: 2026-10-11
> العَرَض: `public.ofoq_admin_alert_details(...)` يعمل في SQL Editor ويعيد البيانات،
> لكن `/admin/alerts/[id]` يعرض «Supabase portal migration is not installed yet».

هذه الصفحة تشرح ما فُحص في الكود، وما تغيّر، وكيف تُقرأ السجلات، والأوامر الدقيقة التي تُنهي المشكلة.

---

## ١. الجواب المباشر على الأسئلة الثلاثة

| السؤال | الجواب قبل الإصلاح | الآن |
| --- | --- | --- |
| هل `src/app/api/admin/alerts/[id]/route.ts` يقرأ الكوكيز من الطلب؟ | كان يقرأها **ضمنيًا** عبر `cookies()` من `next/headers` (داخل Route Handler هذا يعمل ويقرأ كوكيز الطلب). | صار يقرأها **صريحًا** من `Request` عبر `requireSupabaseUser(request)` → `createSupabaseRouteClient()` |
| هل يستخدم `createServerClient` من `@supabase/ssr` بشكل صحيح؟ | نعم — لم يكن `createBrowserClient` مستخدمًا في أي API route. | نعم، وبصيغة الـ Route Handler الكاملة: قراءة كوكيز الطلب + إعادة كتابة كوكي الجلسة المُحدَّث على **الاستجابة** |
| هل يمرر الجلسة في الهيدر؟ | الجلسة تُمرَّر كـ `Authorization: Bearer <access_token>` تلقائيًا من SDK إلى Supabase، لكن **لا شيء كان يجدّد التوكن المنتهي** لمسارات `/api/*` | الـ middleware أصبح يشمل `/api/admin/:path*` و`/api/me` و`/api/dashboard`، والتجديد يُكتب على الاستجابة |

**النتيجة المهمة:** الكوكيز كانت تصل فعلًا — والدليل أن `/api/me` يعمل (بوابة `/admin` لا تفتح أصلًا لو لم تصل الجلسة). لذلك رسالة «migration is not installed» لم تكن بسبب الجلسة، بل لأن **الـ Data API لا يرى الدالة** بينما SQL Editor يراها. هذا هو الفرق الجوهري:

```text
SQL Editor  → SELECT public.ofoq_admin_alert_details('<id>');      ✅ يعمل
الموقع      → POST /rest/v1/rpc/ofoq_admin_alert_details            ❌ PGRST202
```

`PGRST202: Could not find the function public.ofoq_admin_alert_details(p_alert_id) in the schema cache`

يكفي أن يختلف **اسم الوسيط** أو أن تكون **ذاكرة PostgREST المؤقتة قديمة** ليظهر هذا الخطأ رغم أن الدالة موجودة: PostgREST يبحث عن الاسم **مع أسماء الوسائط** معًا.

---

## ٢. الأسباب المحتملة مرتّبة، وكيف يميّزها الكود الآن

| # | السبب | ما يميّزه |
| --- | --- | --- |
| 1 | **الدالة غير موجودة على المشروع الذي يتصل به الموقع** (الترحيل طُبِّق على مشروع آخر) | `projectRef.session` ≠ `projectRef.fromConfigUrl` في السجل → الرمز `SESSION_PROJECT_MISMATCH` |
| 2 | **ذاكرة PostgREST المؤقتة قديمة** (الدالة موجودة لكن الـ API لا يراها) | `RPC_NOT_INSTALLED` مع إشارة إلى `NOTIFY pgrst, 'reload schema';` |
| 3 | **الدالة موجودة بأسماء وسائط أخرى** (`p_id` بدل `p_alert_id`) | `RPC_SIGNATURE_MISMATCH` (الرمز `42883`) + أمر `DROP FUNCTION` الجاهز |
| 4 | **جدول ناقص** (`public.customers`/`public.activities`) | `TABLE_NOT_INSTALLED` |
| 5 | **الجلسة لم تُجدَّد** فانتهى التوكن | سطر `[route-auth] session rejected` مع `refreshOnly: true` |
| 6 | **الدور غير مسموح** (`ofoq_is_staff()` = false) | `RPC_FORBIDDEN` (403) |

---

## ٣. ما تغيّر في الكود

| الملف | التغيير |
| --- | --- |
| `src/lib/supabase/session-diagnostics.ts` (جديد) | يقرأ كوكي الجلسة (بما فيها المجزّأة `…auth-token.0/.1`) ويفكّ حمولة الـ JWT بلا تحقّق من التوقيع لاستخراج `ref` (مشروع التوكن) و`sub` و`role` و`exp` فقط. **لا تُسجَّل قيم الكوكيز ولا التوكنات إطلاقًا** — أسماء وأطوال وادّعاءات غير سرّية فقط. |
| `src/lib/supabase/rpc-diagnostics.ts` (جديد) | يحوّل خطأ PostgREST واحدًا إلى `kind` + `code` + `explanation` + `hint` (SQL جاهز للنسخ). |
| `src/lib/supabase/route-client.ts` (جديد) | عميل Supabase مبني على كوكيز **الطلب نفسه**، ويكتب الجلسة المُحدَّثة على الاستجابة (نمط Route Handler الرسمي). |
| `src/lib/supabase/postgrest-introspection.ts` (جديد) | يقرأ وثيقة OpenAPI الخاصة بمشروعك (`GET /rest/v1/`) **بجلستك** ويعرض أسماء دوال RPC ووسائطها كما يراها الـ API فعلًا. |
| `src/lib/admin/alert-rpc-contract.ts` (جديد) | التوقيعات الخمسة المتوقعة (`ofoq_admin_alerts`, `…_alert_details`, `…_acknowledge_alert`, `…_resolve_alert`, `…_reply_to_client`) ومقارنتها بالمثبّت. |
| `src/app/api/admin/alerts/[id]/route.ts` + `alerts/route.ts` | يمرّران الطلب، ويسجّلان سطرًا كاملًا عند كل فشل، ويُعيدان `{ error, code, hint, requestId }` بدل رسالة عامة. |
| `src/app/api/debug/alerts/route.ts` (جديد) | تقرير كامل من جهة الخادم: الجلسة + المشروع + دوال RPC المكشوفة + محاولة حقيقية على تنبيه موجود. |
| `src/middleware.ts` | أُضيف `/api/admin/:path*` (وأيضًا `/api/me` و`/api/dashboard`) ليجدّد الجلسة قبل أن يقرأها أي route. |
| `db/migrations/supabase/0007_admin_alerts.sql` | أصبح يفحص نفسه ويصلح نفسه: يسقط أي توقيع قديم غير مطابق، ثم تقرير قبل التثبيت وتقرير بعده، و`NOTIFY pgrst, 'reload schema';` في النهاية. |
| `src/components/admin-alert-detail.tsx` | صفحة التنبيه تعرض الرمز والـ hint ومعرّف الطلب، ورابط «تشخيص الاتصال بالـ API». |
| `tests/admin-alert-diagnostics.test.ts` (جديد) | 17 اختبارًا: فكّ الـ JWT، الكوكي المجزّأ، حالة «توكن فقط»، مطابقة المشروع، تصنيف الأخطاء، ومقارنة OpenAPI، وسلوك الـ route مع سجلّه. |

---

## ٤. أين تُقرأ السجلات

| الاستضافة | المسار |
| --- | --- |
| Netlify | Site → **Logs → Functions** ثم ابحث عن `[api/admin/alerts]` أو `[route-auth]` أو `RPC_NOT_INSTALLED` |
| Cloudflare Workers (إن اكتمل إعداد `wrangler.toml`) | Workers & Pages → المشروع → **Logs** → Live / Real-time |

سطر فشل واحد يبدو هكذا (مثال حقيقي من الاختبارات):

```text
[api/admin/alerts] details RPC failed {
  requestId: 'test-request-id', action: 'details',
  alertId: '28cd84e5-…', rpc: 'ofoq_admin_alert_details',
  rpcArgs: { p_alert_id: '<alert id>' },
  userId: 'd9352a7b-…', userEmail: '…', userRole: 'OWNER', userStatus: 'ACTIVE',
  supabaseHost: 'xxxxx.supabase.co',
  session: {
    cookieCount: 4,
    cookieNames: ['ofoq_locale', 'sb-xxxxx-auth-token.0', 'sb-xxxxx-auth-token.1', …],
    expectedAuthCookie: 'sb-xxxxx-auth-token',
    hasExpectedAuthCookie: true,
    authCookie: { name: 'sb-xxxxx-auth-token', valueLength: 5123, chunks: 2, base64Prefixed: true },
    otherAuthCookies: [],
    session: { hasAccessToken: true, hasRefreshToken: true, refreshOnly: false,
               claims: { projectRef: 'xxxxx', role: 'authenticated', userId: 'd9352a7b-…', expiresAt: 1800000000, … } },
    projectRef: { fromSession: 'xxxxx', fromConfigUrl: 'xxxxx', mismatch: false },
    notes: []
  },
  rpcError: { code: 'PGRST202', message: 'Could not find the function …', details: null, hint: null }
}
[rpc] ofoq_admin_alert_details failed (RPC_NOT_INSTALLED) {
  … explanation: 'PGRST202 — the API answered "…"', nextStep: 'Re-run db/migrations/supabase/0007_admin_alerts.sql …'
}
```

**اقرأ بالترتيب:** `projectRef.mismatch` → `cookieNames` (هل كوكي الجلسة موجود؟) → `refreshOnly` → `rpcError.code`. هذه الأربعة تحسم السبب دائمًا.

> ⚠️ لا تُشارك سطر `session` كاملًا في محادثة عامة: فيه `userId` و`email` ومعرّفات. لا يحتوي أي توكن أو قيمة كوكي.

---

## ٥. فحص سريع من المتصفح (بدون سجلات)

سجّل الدخول ثم افتح:

```text
https://<موقعك>/api/debug/alerts                    ← يختار تنبيهًا حقيقيًا بنفسه
https://<موقعك>/api/debug/alerts?alertId=<alerts.id>
```

يُعيد JSON يوضّح:

- `session.projectRef` — مشروع التوكن مقابل مشروع `NEXT_PUBLIC_SUPABASE_URL`، و`session.notes` بلغة واضحة.
- `rpcs[]` — لكل دالة من الخمس: `exposed` / `missing` / `signature_mismatch` مع **أسماء الوسائط المثبّتة فعلًا** (`installedArgs`) مقابل المتوقعة (`expectedArgs`).
- `probe` — نداء حقيقي لـ `ofoq_admin_alert_details` بجلستك، مع الخطأ الخام كاملًا عند الفشل.
- `sql` — أمرا SQL الجاهزان: استعلام التوقيعات المثبّتة، و`NOTIFY pgrst, 'reload schema';`.
- `nextSteps` — الخطوة التالية مصاغة بالإنجليزية بجملة واحدة.

---

## ٦. الإجراء SQL الذي يُنهي المشكلة

### أ) في المشروع الصحيح (نفس مشروع `NEXT_PUBLIC_SUPABASE_URL`)

```sql
-- 1) ما المثبّت فعلًا، وبأي أسماء وسائط؟
SELECT p.oid::regprocedure AS signature,
       pg_get_function_arguments(p.oid) AS args,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('ofoq_admin_alerts','ofoq_admin_alert_details',
                    'ofoq_admin_acknowledge_alert','ofoq_admin_resolve_alert',
                    'ofoq_admin_reply_to_client')
ORDER BY 1;
```

المطلوب أن ترى بالضبط:

```text
ofoq_admin_alert_details(text)   | p_alert_id | t
```

إن ظهرت بأسماء أخرى (مثل `p_id`) فهذا سبب المشكلة: PostgREST يطابق أسماء الوسائط، لذلك `SELECT ofoq_admin_alert_details('<id>')` (استدعاء موضعي) ينجح بينما `rpc(..., { p_alert_id })` يفشل.

```sql
-- 2) أعد تطبيق الترحيل — وهو يتولّى الإسقاط بنفسه
--    db/migrations/supabase/0007_admin_alerts.sql  (أو docs/setup/supabase-setup.sql)
```

**مهم:** لم تعد بحاجة إلى `DROP FUNCTION` يدوي. الملف يبدأ بفحص ذاتي:
كل دالة من الخمس إن وُجدت بتوقيع مختلف عن توقيع التطبيق (`p_alert_id text` …) تُسقط تلقائيًا مع
تحذير صريح يذكر التوقيع الذي أُزيل، ثم تُنشأ النسخة القانونية.

السبب: PostgreSQL يرفض `CREATE OR REPLACE` إذا تغيّر **اسم** الوسيط، بالخطأ:

```text
ERROR: 42P13: cannot change name of input parameter "p_id"
HINT: Use DROP FUNCTION public.ofoq_admin_alert_details(text) first.
```

وفي هذه الحالة يفشل الترحيل كاملًا، فلا تُنشأ أي من الدوال الخمس. (تحقّقنا من هذا السلوك فعليًا على
PostgreSQL 18 داخل بيئة الاختبار، وكذلك من أن الإسقاط يزيل الحالتين: اسم مختلف، ونوع مختلف
(`uuid`) الذي يسبّب التباسًا في PostgREST.)

### ب) أعد تحميل ذاكرة PostgREST (السبب الأشهر عندما تكون الدالة سليمة)

```sql
NOTIFY pgrst, 'reload schema';
```

نفس المفعول من اللوحة: **Settings → API → Reload schema**. الملف `0007_admin_alerts.sql` صار ينفّذ هذا الأمر تلقائيًا في نهايته، ويطبع تقريرًا يشبه:

```text
NOTICE:  ofoq: ✓ ofoq_admin_alert_details(p_alert_id) — executable by authenticated: true
NOTICE:  ofoq: all 5 admin alert RPCs are installed with the expected signatures; …
```

### ج) تأكد أن المتغيرات تشير إلى المشروع نفسه

`NEXT_PUBLIC_SUPABASE_URL` و`NEXT_PUBLIC_SUPABASE_ANON_KEY` من **Project Settings → API** لنفس المشروع الذي طبّقت عليه SQL. قيم `NEXT_PUBLIC_*` تُدمج **وقت البناء**، فأي تغيير يحتاج إعادة نشر (Trigger deploy).

---

## ٧. خطوات الاختبار (المرجع للتحقق بعد النشر)

1. سجّل الدخول كـ OWNER/PARTNER.
2. افتح `/admin/alerts` ثم اختر تنبيهًا → `/admin/alerts/[id]`.
3. إن ظهرت البيانات: انتهت المشكلة.
4. إن ظهر خطأ: لاحظ **الرمز** و**معرّف الطلب** الظاهرين في البطاقة، وافتح `/api/debug/alerts` في نفس الجلسة.
5. في سجلات الاستضافة ابحث عن `requestId` نفسه؛ سطر واحد سيشرح السبب ومعه `nextStep` الجاهز.
6. أعِد التطبيق بعد الإصلاح ثم كرّر من الخطوة 2.

---

## ٨. ما لم يتغيّر (ولماذا)

- **لا مفاتيح service-role** ولا تجاوز لـ RLS: كل نداء يبقى بجلسة المستخدم نفسه، والدالة `SECURITY DEFINER` تُعيد التحقق من `ofoq_is_staff()`.
- **لا كتابة مباشرة** على `alerts`/`messages` من المتصفح: الإجراءات الخمسة تبقى الطريق الوحيد.
- **رسائل المتصفح للعميل** لم تتغيّر: الرموز والـ hints تُضاف فقط حيث يكون المستخدم موظفًا (مسارات `/api/admin/*`).
- **`/api/supabase-proxy` غير مشمول** بمطابقة الـ middleware عن قصد: تمرير كل طلب وسيط عبر جلسة Supabase يضيف رحلة شبكة لكل نداء ويخاطر بحلقة تجديد.

---

## ٩. الجولة الثانية (2026-10-11): إثبات أن الجلسة تصل فعلًا

الشكوى كانت: «الـ RPC يعمل من SQL Editor بجلسة `authenticated`، لكن `/admin/alerts` يعرض
«Supabase portal migration is not installed yet»». هذه الجولة أجابت عن السؤال بالتجربة لا بالقراءة.

### ٩.١ الدليل: اختبار يمرّ عبر الطلب الحقيقي

`tests/admin-alerts-session.test.ts` (جديد) لا يستهزئ بأي وحدة: يشغّل **معالج المسار الحقيقي**
مع `@supabase/ssr` و`supabase-js` الحقيقيين، ويقف على المنفذ خادم HTTP صغير يلعب دور مشروع Supabase
ويسجّل ما وصل إليه PostgREST. ما تم إثباته:

| الفحص | النتيجة |
| --- | --- |
| `Authorization` المرسل إلى `POST /rest/v1/rpc/ofoq_admin_alerts` | `Bearer <access token الخاص بالمستخدم>` — لا مفتاح `anon` |
| `apikey` | مفتاح anon (كما يجب) |
| الوسائط | `{ p_status, p_limit, p_offset }` بالأسماء الصحيحة |
| كوكي مجزّأ `…auth-token.0/.1` | يُقرأ ويُجمَّع كما يكتبه الـ SDK |
| مسار التفاصيل والإجراءات | `Bearer` نفسه مع `ofoq_admin_alert_details` و`…_acknowledge_alert` |
| **توكن منتهي** | يُجدَّد عبر `POST /auth/v1/token?grant_type=refresh_token`، والـ RPC يعمل **بالتوكن الجديد**، والجلسة الجديدة تُكتب على الاستجابة (`Set-Cookie`) |
| بلا كوكي جلسة | 401 `AUTH_REQUIRED` بلا أي نداء RPC |

ونُفِّذ الشيء نفسه على **سيرفر Next.js حقيقي** (`npm run dev` + مشروع Supabase وهمي):

```text
GET /api/admin/alerts?status=OPEN          → 401  + [admin-alerts] hasSession:false
GET /api/admin/alerts?status=OPEN (جلسة)   → 200  { data: { items: [...] } }
    المشروع الوهمي استلم: POST /rest/v1/rpc/ofoq_admin_alerts  Authorization: Bearer <JWT>
GET /api/admin/alerts/<id>                 → 200  { data: { alert, conversation, messages } }
GET /api/me                                → 200  { data: { role: "OWNER", ... } }
مجلسة منتهية الصلاحية → POST /auth/v1/token (تجديد) → الـ RPC بالتوكن الجديد + Set-Cookie
```

**الخلاصة:** كود الموقع يمرّر جلسة الطلب إلى الـ RPC بالشكل الصحيح. لذلك إذا استمرت الرسالة على
الموقع المنشور، فالسبب في **المشروع** (ترحيل غير مطبَّق/ذاكرة PostgREST/عمود ناقص) أو في **نسخة
نشر قديمة** — وليس في تمرير الكوكيز.

### ٩.٢ عقد السجل: سطر واحد باسم `[admin-alerts]`

`src/lib/admin/alert-route-log.ts` (جديد) يكتب **سطرًا واحدًا لكل فشل** — بما فيها الحالات التي لم تكن
تُسجَّل إطلاقًا سابقًا (قراءة الملف الشخصي، غياب الجلسة). الأربعة التي تُقرأ أولًا:

```text
[admin-alerts] {
  route: 'GET /api/admin/alerts',
  action: 'list',
  reason: 'rpc',              // 'auth_required' | 'profile' | 'rpc'
  hasSession: true,           // جلسة مؤكَّدة (auth.getUser نجح)؟
  userId: 'd9352a7b-…',       // null عندما لا توجد جلسة مؤكَّدة
  cookieCount: 4,             // عدد الكوكيز الواصلة فعلًا
  rpcError: { code: 'PGRST202', message: '…', details: null, hint: null },
  // ثم: requestId، userEmail، userRole، sessionUserId (من داخل التوكن)، rpc (الجدول أو الدالة)،
  //      rpcArgs (أسماء فقط)، cookieNames، expectedAuthCookie، hasExpectedAuthCookie،
  //      sessionCookie (الطول/التجزئة فقط)، claims، refreshOnly، projectRef، sessionNotes، note
}
```

وسطر `[route-auth] session rejected` صار يحمل `hasSession: false` أيضًا، فأصبح البحث في سجلات
Cloudflare/Netlify بكلمة واحدة كافيًا:

```text
[admin-alerts]      → ما رآه المسار بالضبط لحظة الفشل
[route-auth]        → لماذا رُفضت الجلسة (refreshOnly؟ كوكي بمشروع آخر؟ توصيل مفقود؟)
[rpc] <الدالة> failed → التصنيف والخطوة التالية الجاهزة
```

### ٩.٣ الحالة التي كانت تُنتج الرسالة **بلا أي سطر سجل**

قبل هذه الجولة كان `/api/admin/alerts` يقرأ ملف الموظف من `public.users` **قبل** الـ RPC، وإذا فشلت
هذه القراءة (عمود ناقص، ذاكرة schema قديمة، ترحيل جزئي، RLS) يعيد الرسالة نفسها
«Supabase portal migration is not installed yet» — بينما لا يوجد أي سطر `[api/admin/alerts]`، فقط
`[rpc] fetchOwnProfile failed` بلا جلسة ولا مستخدم. الآن:

- الرمز صار واضحًا: **`PROFILE_READ_FAILED`**، والرسالة تسمّي الجدول:

```text
Your staff profile could not be read from the database (public.users).
The portal SQL is applied only partially, or the Data API's schema cache is stale.
```

- والـ hint يقول ما يجب فعله، والسجل يقول صراحة:

```text
note: 'the profile read failed BEFORE any alert RPC ran — the page message is not about ofoq_admin_alerts'
rpcError: { code: 'PGRST204', message: "Could not find the 'locale' column of 'users' in the schema cache" }
nextStep: '… Reload the schema cache … Reading: public.users (id, name, email, role, status, locale).'
```

هذا يفرّق بين «الترحيل غير مطبَّق على جدول المستخدمين» و«دوال التنبيهات غير مكشوفة» — وهما كانا
متطابقين تمامًا في رسالة واحدة سابقًا (الخطأ `PGRST204` يخصّ عمودًا، لا دالة).

### ٩.٤ الجلسة تُقرأ من الطلب — في كل المسارات

قاعدة واحدة الآن: كل مسار يقرأ جلسة يمرّر طلبـه إلى `requireSupabaseUser(request)`، وإذا جدّد الـ SDK
التوكن يُعاد كتابته على الاستجابة عبر `jsonWithSession`.

| المسار | قبل | بعد |
| --- | --- | --- |
| `/api/admin/alerts` · `/api/admin/alerts/[id]` | `requireSupabaseUser(request)` ✅ | كما هو + سجل موحّد |
| `/api/me` · `/api/dashboard` · `/api/admin/dashboard` | كوكيز البيئة المحيطة (`next/headers`) | الطلب + `jsonWithSession` |
| `/api/admin/ai/models` · `…/ai/usage` · `…/ai/test` | محيطة | الطلب + `requestId` في `requireOwnRole` |
| `/api/email/send` · `/api/debug/escalation` | محيطة | الطلب |
| `/api/chat` (GET/POST) · `/api/ai/chat` | محيطة | الطلب |

### ٩.٥ middleware: مسارات ناقصة اكتشفها اختبار الحرس

أُضيف اختبار «**covers every session-reading API route in the middleware matcher**»: يمرّ على
`src/app/api`، يجد كل مسار يستدعي `requireSupabaseUser(`، ويفشل إن لم يغطِّه `config.matcher`.
أول تشغيل له كشف ثلاث فجوات حقيقية، فأُضيفت:

```ts
"/api/debug/:path*",   // /api/debug/alerts و /api/debug/escalation
"/api/email/:path*",   // /api/email/send
```

(المستثنيان الوحيدان المقصودان: `/api/chat` و`/api/ai/chat` — يقبلان عملًا قبل وجود الجلسة.)

### ٩.٦ خطوات التحقق عندك

1. سجّل الدخول، ثم افتح `/api/debug/alerts` — تقرير الجلسة والمشروع والدوال المكشوفة ونداء حقيقي.
2. افتح `/admin/alerts`، ثم `/admin/alerts/<id>`.
3. في سجلات الاستضافة ابحث عن `[admin-alerts]` واقرأ الأربعة: `hasSession` → `userId` →
   `cookieCount` → `rpcError.code`.

| ما تراه | المعنى | الخطوة |
| --- | --- | --- |
| `reason: 'auth_required'`, `cookieCount: 0` | الكوكيز لا تصل للمسار | افحص نطاق الـ middleware/الوسيط، وسجّل دخولًا جديدًا |
| `reason: 'auth_required'`, `hasExpectedAuthCookie: true`, `sessionUserId` موجود | الكوكي وصل لكن التوكن مرفوض (منتهٍ/مشروع آخر) | راقب `refreshOnly` و`projectRef.mismatch` |
| `reason: 'profile'` + `PROFILE_READ_FAILED` | قراءة `public.users` فشلت قبل أي RPC | طبّق `docs/setup/supabase-setup.sql` ثم `NOTIFY pgrst, 'reload schema';` |
| `reason: 'rpc'`, `PGRST202` وبلا `projectRef.mismatch` | الدالة غير مرئية للـ Data API | أعد تطبيق `db/migrations/supabase/0007_admin_alerts.sql` (يتولى `DROP` للتوقيعات القديمة) ثم أعد تحميل الذاكرة |
| `reason: 'rpc'`, `projectRef.mismatch: true` | الجلسة من مشروع آخر | صحّح `NEXT_PUBLIC_SUPABASE_URL` وأعد النشر |
| `42883` | الدالة بأسماء وسائط مختلفة | الملف نفسه يسقط التوقيع القديم ويعيد الإنشاء |
| `42501` | `ofoq_is_staff()` = false | تحقق من `public.users.role/status` |

### ٩.٧ الملفات المتغيرة في هذه الجولة

| الملف | التغيير |
| --- | --- |
| `src/lib/admin/alert-route-log.ts` (جديد) | سطر `[admin-alerts]` الواحد: `hasSession`/`userId`/`cookieCount`/`rpcError` + سياق الجلسة، ويعمل عند غياب الجلسة أيضًا |
| `src/lib/supabase/route-auth.ts` | `requireOwnRole` يعيد `reason` و`error`، وقراءة الملف الشخصي تُشخَّص كـ `PROFILE_READ_FAILED` مع اسم الجدول والأعمدة؛ `hasSession: false` في سطر رفض الجلسة |
| `src/lib/supabase/rpc-diagnostics.ts` | `resource` / `codeOverride` / `messageOverride` في سياق الفشل (تسمية الجدول الحقيقي في الشرح والخطوة التالية) |
| `src/lib/supabase/session-diagnostics.ts` | `describeRequestSession(request)` — تقرير جلسة من الطلب نفسه لكل مسار |
| `src/app/api/admin/alerts/route.ts` و`[id]/route.ts` | سجل موحّد على كل مسار فشل (جلسة/ملف شخصي/RPC) + تمرير الطلب |
| `src/app/api/{me,dashboard,admin/dashboard,admin/ai/*,email/send,debug/escalation,chat,ai/chat}/route.ts` | الجلسة من الطلب، وإعادة كتابة الجلسة المجدَّدة على الاستجابة |
| `src/middleware.ts` | `/api/debug/:path*` و`/api/email/:path*` |
| `tests/admin-alerts-session.test.ts` (جديد) | 5 اختبارات: البرهان على مرور `Bearer`، الكوكي المجزّأ، التفاصيل والإجراءات، التجديد، و401 |
| `tests/admin-alert-diagnostics.test.ts` | اختبار حرس الـ middleware + ثلاث حالات لسطر `[admin-alerts]` (بلا جلسة، فشل قراءة الملف الشخصي، فشل الـ RPC) |

---

## ١٠. الجولة الثالثة (2026-10-12): زر «إرسال الرد» — لماذا لم يستجب، وكيف صار يستجيب

> العَرَض: صفحة تفاصيل التنبيه تفتح كاملة ✅ لكن زر **«إرسال الرد»** لا يُظهر أي استجابة،
> وكذلك زر **«تم الحل»**.

### ١٠.١ نتيجة الفحص (ما كان موجودًا فعلًا)

| السؤال | النتيجة |
| --- | --- |
| هل `src/app/api/admin/alerts/[id]/reply/route.ts` موجود؟ | **لا**. لم يكن هناك مسار مخصّص للرد؛ كان الرد يُنفَّذ عبر `POST /api/admin/alerts/[id]` بحمولة `{ action: "reply", body, language }`. |
| هل أسماء الوسائط في الكود مطابقة لتعريف الدالة؟ | **نعم.** الكود يرسل `{ p_alert_id, p_body, p_language }` و`0007_admin_alerts.sql` تُعرّف `ofoq_admin_reply_to_client(p_alert_id text, p_body text, p_language text DEFAULT 'ar')` — لا اختلاف في الأسماء، ولا `p_conversation_id`. |
| هل الدالة تتعامل مع المحادثة؟ | الدالة تأخذ `p_alert_id` وتستخرج `entity_id` (وهو `conversation_id`) بنفسها: التصعيد يُنشئ التنبيه بـ `entity_type='conversation'` و`entity_id=<conversation id>`. لذلك لا حاجة لأي وسيط باسم `p_conversation_id`. |
| أين كانت المشكلة إذًا؟ | في ثلاث نقاط مجتمعة: (1) كنّـا ننتظر أنّ الزر لا يستجيب لأن النتيجة تظهر في **أعلى الصفحة** بعيدًا عن الزر؛ (2) إذا رجع الـ API خطأً (مثلًا `PGRST202` لأن الدالة غير مكشوفة على المشروع) فإن الزر يبدو ميتًا؛ (3) الكتابة تُمسح فقط بعد النجاح لكن **لا يوجد أي تأكيد قريب** من الزر يقول «تم الإرسال بنجاح». |

باختصار: الكود كان سليمًا، والتجربة لم تكن تُظهر نتيجة الفعل. لذلك صار لكل زر مسار خاص، وتأكيد/خطأ **داخل نفس البطاقة**.

### ١٠.٢ المسارات الجديدة (نقطة نهاية لكل زر)

```text
POST /api/admin/alerts/[id]/reply
     Body: { "body": "…", "language": "ar" | "en" }
     يقبل كذلك: { "message": … }  |  { "text": … }  |  { "p_body": …, "p_language": … }
     200 → { "data": <ofoq_admin_alert_details payload> }   ← الرسالة الجديدة تظهر بلا إعادة تحميل
     400 → { "error": …, "code": "INVALID_REPLY_BODY" } | { "code": "INVALID_ALERT_ID" }
     401 → AUTH_REQUIRED   403 → الدور ليس OWNER/PARTNER
     503 → RPC_NOT_INSTALLED (معه hint ورابط /api/debug/alerts)

POST /api/admin/alerts/[id]/resolve
     Body: { "note": "…" }        ← اختياري، بحد 2000 حرف
     200 → { "data": <…> }  حيث status = RESOLVED
```

`POST /api/admin/alerts/[id]` بالصيغة القديمة `{ action: … }` **ما زال يعمل** كي لا تتعطّل نافذة
متصفح محمّلة سابقًا بعد النشر؛ والأمران يمرّان بنفس البوابة ونفس التسجيل.

### ١٠.٣ ما تغيّر في الواجهة

- الرد صار داخل `<form onSubmit={…}>` والزر `type="submit"`، وكذلك «تم الحل» — فاضغط Enter أو الزر.
- **تأكيد النجاح** يظهر داخل البطاقة: «✓ تم الإرسال بنجاح» / «✓ تم الحل بنجاح» (`role="status"`).
- **الخطأ** يظهر أيضًا داخل البطاقة مع الرمز ومعرّف الطلب ورابط التشخيص (`role="alert"`)، والنصّ
  المكتوب **لا يُمسح** عند الفشل.
- خانة الرد تُمسح **فقط** بعد نجاح الـ RPC.
- «تم الحل» يعيد رسم الصفحة من حمولة الـ RPC: الحالة تصبح RESOLVED، وتظهر ملاحظة «تم إغلاق التنبيه».

### ١٠.٤ التحقق من أسماء الوسائط على مشروعك (بدون سجلات)

`GET /api/debug/alerts` صار يفحص **أزرار الكتابة** فعليًا:

- `actionProbes.reply` و`actionProbes.resolve`: كل واحد يُنادى بمعرّف تنبيه مستحيل
  (`00000000-0000-0000-0000-000000000000`)، فيكون الجواب:
  - `ready` (الرمز `P0002`) → أسماء الوسائط صحيحة والدالة تصل وتعمل، ولم يُكتب أي صف.
  - `not_exposed` (`PGRST202`/`42883`) → هذه هي علّة الزر، ومعها الأمر الجاهز.
  - `permission_denied` (`42501`) → منح `EXECUTE` ناقص.
- `replyability`: يشرح لماذا قد يكون الزر معطّلًا: `no_conversation` (التنبيه غير مرتبط بمحادثة)
  أو `resolved` (التنبيه مُغلق).
- `sql.signatures` نفس أمر `pg_get_function_arguments` الجاهز للنسخ.

وللتحقق يدويًا في SQL Editor (المطلوب حرفيًا):

```text
ofoq_admin_reply_to_client(text,text,text) | p_alert_id text, p_body text, p_language text
ofoq_admin_resolve_alert(text,text)         | p_alert_id text, p_note text
```

### ١٠.٥ إثبات أن الزر يعمل فعلًا (اختبار E2E)

`tests/admin-alert-reply-e2e.test.tsx` يشغّل **المكوّن الحقيقي** في DOM، ويوجّه `fetch` إلى
**معالجات المسارات الحقيقية**، وتلك تتكلم مع خادم HTTP صغير يلعب دور PostgREST — بما في ذلك قاعدة
مطابقة **أسماء الوسائط** نفسها. الاختبارات:

| الفحص | النتيجة |
| --- | --- |
| كتابة رد ثم الضغط على «إرسال الرد» | `POST /rest/v1/rpc/ofoq_admin_reply_to_client` بـ `{ p_alert_id, p_body, p_language }` و`Authorization: Bearer <جلسة الموظف>` |
| الرسالة المحفوظة | صف بجانب `sender_type='STAFF'` وبالنص المكتوب نفسه |
| الواجهة بعد النجاح | «تم الإرسال بنجاح» + مسح الخانة |
| «تم الحل» | `POST …/rpc/ofoq_admin_resolve_alert` بـ `{ p_alert_id, p_note }` ثم RESOLVED |
| دالة مثبّتة بأسماء وسائط أخرى | بطاقة خطأ داخل البطاقة (`RPC_NOT_INSTALLED` + `/api/debug/alerts`) والنص **يبقى** في الخانة |
| الحزمة القديمة `{ action: "reply" }` | ما زالت تعمل وتُرسل الأسماء الثلاثة الصحيحة |
| «تأكيد المتابعة» | ينتقل التنبيه إلى ACKNOWLEDGED ويظهر التأكيد أعلى البطاقة |

### ١٠.٦ إثبات على قاعدة بيانات حقيقية (PostgreSQL)

`tests/admin-alert-sql-execution.test.ts` يشغّل **PostgreSQL 18 حقيقيًا** (PGlite داخل Node) ويُنفّذ
**نفس SQL الموجود في المستودع**: جداول `docs/setup/supabase-setup.sql`، ودوال `ofoq_admin_*` مقتطعة
منه حرفيًا. ما ثبت:

| الفحص | النتيجة |
| --- | --- |
| `pg_get_function_arguments` لـ `ofoq_admin_reply_to_client` | `p_alert_id text, p_body text, p_language text` |
| لـ `ofoq_admin_resolve_alert` | `p_alert_id text, p_note text` |
| نداء بأسماء مختلفة (`p_conversation_id => …`) | يفشل بالرمز **42883** وهذه علّة «الزر لا يستجيب» إن حدثت لمشروع ما |
| نداء بالأسماء الصحيحة | صف في `public.messages` بـ `sender_type='STAFF'` و`sender_user_id = auth.uid()` و`meta` يحمل `admin-alert-centre` و`alertId` |
| أثر الرد على المحادثة | `status='OPEN'`، `unread_for_client` +1، `unread_for_staff = 0`، وتحديث `last_message_at` |
| التنبيه الجديد | يصبح `ACKNOWLEDGED` + سجل `alert.replied_to_client` |
| الرد لا يذهب لمحادثة أخرى | ✅ صفر صفوف في محادثة تنبيه آخر |
| «تم الحل» | `status='RESOLVED'` + السجل `alert.resolved` يحفظ الملاحظة، وإعادة الحل لا تُكرر السجل |
| جلسة غير موظف | `42501` ولا كتابة |
| الـ probe بمعرّف التنبيه المستحيل | `P0002` (نسخة الرد: `Alert is not linked to a client conversation`، ونسخة الحل: `Alert not found`) و**صفر كتابة** |
| حمولة التفاصيل | تُعيد رسالة `STAFF` الأخيرة و`conversation` و`activities` — نفس ما تعرضه الصفحة |

### ١٠.٧ التشغيل محليًا

```bash
npx vitest run tests/admin-alert-reply-e2e.test.tsx    # 6 اختبارات (E2E: مكوّن → مسار → PostgREST)
npx vitest run tests/admin-alert-sql-execution.test.ts # 8 اختبارات (PostgreSQL حقيقي)
npx vitest run tests/admin-alert-action-routes.test.ts # 11 اختبارًا (بروتوكول المسارين + التشخيص)
npx vitest run tests/admin-alert-probes.test.ts        # 7 اختبارات (منطق الـ probes)
```

### ١٠.٨ الملفات المتغيرة في هذه الجولة

| الملف | التغيير |
| --- | --- |
| `src/app/api/admin/alerts/[id]/reply/route.ts` (جديد) | مسار إرسال الرد: `{ body, language }` → `ofoq_admin_reply_to_client` مع رموز 400/401/403/503 واضحة |
| `src/app/api/admin/alerts/[id]/resolve/route.ts` (جديد) | مسار «تم الحل»: `{ note? }` → `ofoq_admin_resolve_alert` |
| `src/lib/admin/alert-route-guard.ts` (جديد) | البوابة والتسجيل المشتركان لكل مسارات التنبيهات (`requireStaffAccess`, `failAlertRequest`, ثوابت `ALERT_ACTION_RPC`) |
| `src/lib/admin/alert-action-probes.ts` (جديد) | منطق الـ probes (نداء بمعرّف مستحيل) + `verdictForReplyability` |
| `src/app/api/admin/alerts/[id]/route.ts` | يستخدم البوابة المشتركة، ورموز الأخطاء صارت دقيقة (`INVALID_ACTION`, `INVALID_REPLY_BODY`, …) |
| `src/app/api/debug/alerts/route.ts` | يضيف `actionProbes` و`replyability` وخطوات تالية تسمّي الزر الفاشل |
| `src/components/admin-alert-detail.tsx` | نماذج `onSubmit` ونقاط نهائية لكل زر + تأكيد/خطأ داخل البطاقة + مسح الخانة بعد النجاح فقط |
| `src/app/globals.css` | أنماط `.admin-action-feedback` و`.admin-action-error` و`.admin-acknowledge-control` |
| `vitest.config.ts` | تشمل الاختبارات `.test.tsx` وتُفعّل JSX runtime التلقائي (لاختبارات المكوّنات) |
| `tests/admin-alert-reply-e2e.test.tsx` (جديد) | 6 اختبارات E2E: كتابة→ضغط→تأكيد→رسالة STAFF، والحل، والمتابعة، وحالة فشل الدالة |
| `tests/admin-alert-action-routes.test.ts` (جديد) | 11 اختبارًا: أسماء الوسائط على الشبكة، الحدود، الجلسة، والتصنيفات |
| `tests/admin-alert-probes.test.ts` (جديد) | 7 اختبارات: منطق الـ probes وكونه بلا كتابة، وقاعدة تعطيل زر الرد |
| `tests/admin-alert-sql-execution.test.ts` (جديد) | 8 اختبارات على PostgreSQL 18 حقيقي: التوقيعات، ورسالة `STAFF` فعلية، والحل، والـ probes |
| `tests/helpers/api-bridge.ts` (جديد) | يوجّه `fetch` في الاختبارات إلى معالجات المسارات الحقيقية مع كوكي الجلسة |
| `tests/admin-alert-diagnostics.test.ts` | اختبار الحرس صار يغطي المسارين الجديدين والبواية المشتركة |

### ١٠.٩ قائمة تحقق سريعة بعد النشر

1. افتح `/api/debug/alerts` وأنت مسجّل: تأكد أن `actionProbes.reply.status = "ready"`.
2. افتح تنبيهًا، اكتب ردًا، اضغط «إرسال الرد» → يجب أن تظهر «✓ تم الإرسال بنجاح» أسفل الزر.
3. تحقق في Supabase SQL Editor:

```sql
SELECT sender_type, left(body, 60) AS body, created_at
FROM public.messages
WHERE conversation_id = '<conversation id>'
ORDER BY created_at DESC
LIMIT 5;
```

يجب أن ترى صفًا بـ `sender_type = 'STAFF'`.
