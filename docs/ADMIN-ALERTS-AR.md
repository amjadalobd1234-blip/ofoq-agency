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
