# طلبات الخدمة الموجّهة — الحفظ، التنبيه، والميزانية

هذا المستند يشرح ماذا يحدث عندما يُكمل العميل طلب الخدمة الموجّه في الدردشة
(`/portal/chat?intent=service_request`)، وكيف تُقرأ الميزانية المكتوبة، ولماذا
يُحفظ العرض بحالة `DRAFT` حاليًا.

## المسار بعد الإجابة الأخيرة

```
الدردشة (assistant-chat.tsx)
  └─ POST /api/chat/service-request  { requestId, answers, locale, conversationId }
       └─ submitServiceRequest(input, { store: supabaseServiceRequestStore(client) })
            ├─ prepareServiceRequestOffer()   ← التسعير + صفّ offers + ملخّص
            ├─ RPC public.ofoq_client_service_request(...)   ← معاملة واحدة
            │     ├─ offers         (status = DRAFT, code = OFOQ-<سنة>-NNN)
            │     ├─ alerts         (category = NEW_REQUEST, severity = IMPORTANT)
            │     ├─ notifications  (IN_APP لكل الفريق + EMAIL للمالك)
            │     └─ activities     (service_request.submitted)
            └─ Resend → بريد المالك «🔔 طلب خدمة جديد #OFOQ-…»
```

- **هذا المسار منفصل تمامًا عن التصعيد** (`ofoq_client_escalate`). التصعيد يبقى
  لطلب شخص بشري أو الشكاوى (`HUMAN_REQUEST` / `URGENT`) ولفهم الاحتياج في
  المحادثة الحرة (`NEW_LEAD`). طلب الخدمة المكتمل **لا يمرّ به أبدًا**.
- أثناء الطلب الموجّه، ترسل الدردشة أي رسالة لا تطابق خيارًا إلى `/api/chat`
  مع `intent: "service_request"`؛ عندها يتجاهل `detectEscalation` مفردات
  التواصل («واتساب»، «رقمي…») ووعود التحويل، ولا يرفع `NEW_LEAD`. طلب شخص بشري
  صريح أو شكوى ما زالا يصعّدان.
- `requestId` مفتاح تكرار (idempotency): إعادة المحاولة بنفس المعرّف تُرجع نفس
  رقم الطلب ولا تُنشئ صفًا ثانيًا (`created = false`).

## التنبيه الذي يراه الفريق

| الحقل | القيمة |
| --- | --- |
| `category` | `NEW_REQUEST` |
| `severity` | `IMPORTANT` |
| `title_ar` | `طلب خدمة جديد #OFOQ-2026-001` |
| `entity_type` / `entity_id` | `conversation` + معرّف المحادثة إن وُجدت، وإلا `service_request` + معرّف العرض |
| `dedupe_key` | `service-request:<requestId>` |
| `target_role` | `ANY_STAFF` |

أول سطر في `body_ar` هو `رقم الطلب: OFOQ-…`، ثم الخدمة والحجم والميزانية
والمنطقة ونطاق السعر وقناة التواصل.

### إذا اختار العميل واتساب

يُحفظ الرقم **كما كتبه العميل** مع رابط مباشر بالصيغة الدولية:

```
قناة التواصل: واتساب
رقم العميل: 07707048629
رابط واتساب: https://wa.me/9647707048629
```

وفي `alert.meta`:

```json
{
  "contact":  { "channel": "whatsapp", "value": "07707048629", "whatsappNumber": "9647707048629", "whatsappLink": "https://wa.me/9647707048629" },
  "whatsapp": { "channel": "واتساب", "number": "07707048629", "international": "9647707048629", "link": "https://wa.me/9647707048629" }
}
```

التطبيع في `normalizeWhatsappNumber()`: أرقام عربية → لاتينية، إزالة `+`
و`00`، و`0…` العراقي → `964…`. الرقم في المثال أعلاه توضيحي فقط؛ يُستخدم دائمًا
رقم العميل الفعلي. يظهر الرابط قابلًا للنقر في تفاصيل التنبيه (`/admin/alerts/<id>`)
وفي بريد المالك.

## فهم ما يكتبه العميل في كل خطوة

كل خطوة اختيار (`TYPE`، `SIZE`، `BUDGET`، `TARGETING`، `CONTACT`) تُقرأ
بطبقتين، بهذا الترتيب:

1. **القواعد** (`matchOption` في `src/lib/agents/service-request.ts`): مطابقة
   كاملة ثم جزئية بعد تطبيع النص (إزالة التشكيل، توحيد الهمزة، وطي أشكال
   الحروف). «البصرة» و«السعودية» و«الموقع» تُفهم هنا بلا أي اتصال بالنموذج.
2. **طبقة النية بالذكاء الاصطناعي** (`src/lib/agents/step-intent.ts` عبر
   `POST /api/chat/step-intent`، Groq أولًا): عندما تفشل القواعد — «بصرا»،
   «أريد أشتغل بالبصرة»، «بغداد والبصرة»، «بريد»، «المكان»، «كل العراق».
   يُرسل إلى النموذج: الخطوة، والسؤال المعروض، وخيارات الخطوة المنشورة
   بتسميتيها، ويُجيب بـ `{"match":"basra","confidence":0.95}`.

### البوابة: لا تخمين أبدًا

`acceptStepIntent()` (في `service-request.ts`، مشتركة بين المسار والدردشة حتى
تبقى قاعدة واحدة) تقبل الجواب فقط إذا:

- كانت القيمة خيارًا منشورًا في الخطوة نفسها — بعد جدول المرادفات
  (`site` → `website`، `gmail` → `email`، `gcc` → `gulf`، `logo` → `design`…)،
  وبعد مرور الجواب في المطابق نفسه، فتُفهم تسمية الخيار أيضًا
  («🌊 البصرة فقط» → `basra`)،
- وكانت `confidence ≥ 0.7` (`STEP_INTENT_MIN_CONFIDENCE`). الثقة الغائبة رفض.

وإلا فالنتيجة `null`: تُعرض الخيارات من جديد ولا يُحفظ شيء. غياب المزوّد أو
فشلُه يعامَلان المعاملة نفسها — لا استثناء ولا تخمين. خطوة `TYPE` تحتفظ أيضًا
بالمستخلص المتخصص (`POST /api/chat/service-intent`) قبل الطبقة العامة.

| ما كتبه العميل | الخطوة | الطبقة | النتيجة |
| --- | --- | --- | --- |
| «البصرة» | TARGETING | القواعد | `basra` |
| «السعودية» | TARGETING | القواعد | `gulf` |
| «الموقع» | CONTACT | القواعد | `website` |
| «بصرا» | TARGETING | AI | `basra` |
| «أريد أشتغل بالبصرة» | TARGETING | AI | `basra` |
| «بغداد والبصرة» | TARGETING | AI | `three_cities` |
| «كل العراق» | TARGETING | AI | `iraq_all` |
| «بريد» | CONTACT | AI | `email` |
| «المكان» (والنموذج يجيب `site`) | CONTACT | AI + المرادفات | `website` |
| «ما أدري شلون أشرحلك» | أي خطوة | — | `null` ← الخيارات من جديد |

`options` التي يرسلها المتصفح **تضيّق** الخيارات المنشورة فقط: أي قيمة غير
منشورة تُهمل (وإن بقيت قائمة فارغة تُستخدم القائمة الكاملة)، والتسميات
المرسلة لا تدخل في الـ prompt — يستخدم الخادم تسمياته هو — حتى لا يكتب عميل
تعليمات النموذج.

## الميزانية المكتوبة وتعديلها

### الطبقات الثلاث

1. **الأنماط** (`src/lib/agents/budget-parser.ts`): «من 200 إلى 500»،
   «200-500$»، «$200-500»، «200 إلى 500»، «بين 300 و 700»، «ميزانيتي 350»،
   «300 دولار»، «$300»، وأرقام عربية. رقم مجرّد («300») يُقبل فقط عندما يكون
   سؤال الميزانية مفتوحًا. التواريخ وأرقام الهواتف («07707048629») لا تُعدّ ميزانية.
2. **الذكاء الاصطناعي** (`POST /api/chat/budget-intent`، Groq أولًا): عندما تفشل
   الأنماط — «بين المئتين والخمسمية»، «خمسمية دولار». النموذج يُرجع JSON
   `{min, max, currency}` فقط، ويُتحقق منه ويُطبَّع في `parseBudgetAnswer()`؛
   لا تُحفظ قيمة لم يذكرها العميل. وإن لم يقرأ الاثنان مبلغًا، تُجرَّب طبقة
   النية العامة (`step-intent`) على فئات الميزانية نفسها («ميزانيتي ما تتعدى
   الميتين» → `under_200`) قبل عرض الخيارات من جديد.
3. **التطبيق**: عند سؤال الميزانية تُسجَّل الإجابة؛ وبعد الإجابة (أثناء سؤال
   الاستهداف أو بعد الملخص) تُعدَّل الميزانية في مكانها، ويُعاد حساب التسعير
   وتُعرض النتائج المحدّثة. السؤال المفتوح يبقى مفتوحًا.

رسالة تُقرأ كميزانية **لا تُرسل إلى المساعد ولا تُعامَل كرفض** ولا تُطلب لها
تأكيد إضافي.

### التخزين

| ما كتبه العميل | `answers.budget` (الفئة) | `answers.budgetRange` | `answers.budgetAmount` |
| --- | --- | --- | --- |
| «طيب من 200 إلى 500» | `200_500` | `200-500` | `500` |
| «من 500 الى 200» | `200_500` | `200-500` | `500` |
| «ميزانيتي 350» | `200_500` | `350` | `350` |
| ضغط زر «أقل من 200$» | `under_200` | — | — |

المدى يُحفظ دائمًا بالصيغة `الأدنى-الأعلى` (`200-500`) ولا يُحفظ أبدًا
`500 من 200`. التسعير يُحسب على الحدّ الأعلى (`budgetAmount`)، وتظهر في رسالة
التقدير عبارة «(التقدير محسوب على 500$)». في `offers.pricing_breakdown` تُسجَّل
`budgetBand` و`budgetRange` و`budgetAmount` و`budgetSource` (`typed` / `option`).

## لماذا `DRAFT` وليس `REQUESTED`؟

قيد `offers_status_check` في المخطط الحالي يسمح بـ
`DRAFT / SENT / APPROVED / REJECTED / EXPIRED / CANCELLED` فقط. لذلك:

- يكتب المتجر `DRAFT` اليوم (`SERVICE_REQUEST_OFFER_STATUS`)، وتتحقق الدالة
  `ofoq_client_service_request()` من ذلك وترفض أي حالة أخرى برسالة واضحة.
- الهجرة `db/migrations/supabase/pending/0009_offers_requested_status.sql`
  توسّع القيد وتُرقّي الصفوف المكتوبة. هي **غير مضمّنة** في
  `docs/setup/supabase-setup.sql` عمدًا؛ خطوات تفعيلها مع «PR #2 (Supabase)»
  موجودة في رأس الملف.

## الفشل لا يكون صامتًا

- الدالة غير مثبّتة (`PGRST202`) → `502` بكود `SERVICE_REQUEST_RPC_NOT_INSTALLED`
  وتلميح يشير إلى `0008_service_requests.sql`.
- رفض المخطط (مثلًا حالة غير مسموحة) → `502` بكود `SERVICE_REQUEST_SAVE_FAILED`
  مع التلميح.
- قاعدة البيانات غير متاحة → `SERVICE_REQUEST_RPC_UNREACHABLE`.

في الدردشة تظهر «تعذر حفظ طلبك ❌» مع السبب وزر **إعادة المحاولة** (بنفس
`requestId`). قبل وصول الردّ تظهر «⏳ جارٍ حفظ طلبك وإصدار رقم الطلب…»، وبعد
الحفظ «رقم الطلب: OFOQ-…». إغلاق الصفحة أثناء الحفظ ثم فتحها يُعيد الإرسال
بنفس المعرّف.

## التثبيت على Supabase

طبّق `docs/setup/supabase-setup.sql` في SQL Editor (يحتوي
`0008_service_requests.sql` وتحديث `ofoq_admin_dashboard` ليعدّ `NEW_REQUEST`)،
ثم `NOTIFY pgrst, 'reload schema';`.

إن كانت الرسالة «تعذر حفظ طلبك ❌ … (service_requests.sql — 0008)» على موقع
يعمل أصلًا، فالمخطط ناقص هذه الدالة وحدها: طبّق
`docs/setup/service-requests-migration.sql` (ملف مستقل، آمن لإعادة التشغيل،
يحتوي الدالة + RLS + الصلاحيات + `NOTIFY pgrst` + تقرير ✓/✗). خطوات التطبيق
مكتوبة في رأس الملف.

## الاختبارات

| الملف | ما يغطيه |
| --- | --- |
| `tests/service-request-migration-file.test.ts` | ملف التثبيت المستقل: خطوات عربية، توقيع الدالة، RLS، REVOKE/GRANT، `NOTIFY pgrst`، تقرير ✓/✗، ومطابقة الدالة حرفيًا مع 0008 والحزمة |
| `tests/budget-intent-route.test.ts` | `POST /api/chat/budget-intent`: الصيغ الخمس، القراءة المحلية بلا AI، الميزانية المفتوحة `>500` (المرساة \$1,000) و`<200`، والرجوع إلى الخيارات (`budget: null`) بلا رفض |
| `tests/service-request-sql-execution.test.ts` | الدالة على PostgreSQL حقيقي (PGlite): DRAFT + `OFOQ-…`، تنبيه NEW_REQUEST/IMPORTANT، واتساب في body/meta، الإشعارات، التكرار، رفض REQUESTED |
| `tests/service-request-offer.test.ts` | المتجر المحلي: صفّ offers، التنبيه، meta واتساب، البريد، سجل النشاط، `200-500` |
| `tests/service-request-route.test.ts` | المسار مع عميل Supabase وهمي: RPC الصحيح فقط، لا `ofoq_client_escalate`، أخطاء واضحة |
| `tests/budget-parser.test.ts` | الأنماط (40 حالة) |
| `tests/budget-intent.test.ts` | طبقة الذكاء الاصطناعي مع Groq وهمي |
| `tests/service-request-step-intent.test.ts` | طبقة النية لكل خطوة: الحالات العشر (قواعد ثم AI)، بوابة الثقة 0.7، رفض قيمة غير منشورة أو ثقة ضعيفة، فشل المزوّد وغيابه، و`POST /api/chat/step-intent` كمسار HTTP |
| `tests/assistant-chat-step-intent.test.tsx` | الربط في الدردشة الحقيقية: جسم الطلب المُرسل، حفظ الجواب، وبقاء السؤال مفتوحًا عند ثقة ضعيفة أو قيمة مخترعة |
| `tests/assistant-chat-budget-edit.test.tsx` | التعديل في الدردشة بالأنماط وبالذكاء الاصطناعي، إعادة التسعير، فشل الحفظ وإعادة المحاولة |
| `tests/escalation-agent.test.ts` / `tests/chat-route-escalation.test.ts` | وضع `service_request` لا يصعّد مفردات التواصل أو الميزانية |
