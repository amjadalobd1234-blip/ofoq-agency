# التصعيد إلى فريق بشري — التشخيص والإصلاح (OWNER / CLIENT)

## المشكلة

المساعد كان يردّ:

> «تم تسجيل طلبك للتواصل مع فريق بشري… رسائلك محفوظة في هذه المحادثة وسيطلع عليها فريق أفق، **لكن تعذّر تسجيل تنبيه التحويل المباشر الآن**.»

الجملة الأولى من نصّ النموذج، والثانية من `handoffNotice(locale, "failed")`.
معناها: الرد حُفظ، لكن سطر `alerts` **لم يُكتب**.

## السبب

`public.ofoq_client_escalate()` كان يتعرّف على صاحب المحادثة هكذا:

```sql
SELECT c.customer_id FROM conversations c
  JOIN customers cu ON cu.id = c.customer_id
 WHERE c.id = p_conversation_id AND cu.user_id = auth.uid() AND c.channel = 'WEB';
```

أي أن المتصل يجب أن يكون **عميلًا** له صفّ في `customers`. الحسابات التي أُنشئت قبل
ترايغر `ofoq_create_auth_profile` (أو رُقّيت لاحقًا إلى `OWNER`/`PARTNER`) لها صفّ
في `users` ولا صفّ لها في `customers`، فيُرجع البحث `NULL` ويرتفع استثناء
`42501 Conversation not found` **قبل** الإدخال في `alerts`.

نتيجة ذلك على فرع `main` (مُختبَر على PostgreSQL حقيقي):

| الحالة | قبل | بعد |
| --- | --- | --- |
| `OWNER` بلا صفّ `customers` يفتح المحادثة | `Client profile is not ready` | يُنشأ صفّ العميل تلقائيًا وتُفتح المحادثة |
| `OWNER` يصعّد محادثة عميل | `Conversation not found` | يُنشأ التنبيه |
| عميل يصعّد محادثة عميل آخر | `Conversation not found` | رفض **مفصّل** يذكر المستخدم والدور والمحادثة |

## الإصلاح

1. **`public.ofoq_ensure_customer_profile()`** (في `0001_auth_portal.sql`) — ينشئ صفّ
   `customers` الناقص للحساب المُسجّل دخوله (`customers.id = users.id`، نفس عُرف
   الترايغر). يستدعيه `ofoq_client_chat_bootstrap` قبل فتح أي محادثة، فلا يُحرم أي
   حساب — أيًا كان دوره — من التحدث إلى المساعد.
2. **`db/migrations/supabase/0004_escalation_owner_support.sql`**:
   - ترميم لمرة واحدة: كل حساب بلا صفّ عميل يحصل عليه فور تنفيذ الملف.
   - `ofoq_client_escalate` مُعاد كتابته:
     - تُحلّ المحادثة **أولًا**، فلا يخفي غياب صفّ العميل محادثةً موجودة؛
     - أي `OWNER`/`PARTNER` فعّال يستطيع تصعيد أي محادثة ويب، وصاحب المحادثة
       يحتفظ بحقه；
     - `alerts.customer_id` قد يكون `NULL` (العمود يقبل NULL ولوحة `/admin`
       تستخدم `LEFT JOIN`) — **التنبيه يُكتب على أي حال**؛
     - كل رسالة رفض تذكر `user / role / customer / owner / conversation`；
     - النتيجة تحمل كتلة `identity` لسجلات الخادم.
   - سياسة إدخال `alerts_insert_authenticated` (RLS) مضيّقة إلى صفوف بشكل
     التصعيد فقط. صلاحية الجدول (`GRANT INSERT`) **لم تُمْنَح** عن قصد: المسار
     الوحيد للكتابة يبقى الـ RPC المدقَّق.
   - **`public.ofoq_escalation_diagnostics()`** — RPC واحد يجيب: «لماذا فشل
     التصعيد لهذا الحساب؟».
3. **سجلات الخادم**: كل فشل تصعيد يُسجّل الآن
   `userId / role / customerId / conversationId / category / severity / code / error / hint`.

## التطبيق على المشروع الحي

1. افتح **Supabase → SQL Editor**.
2. نفّذ محتوى `docs/setup/supabase-setup.sql` كاملًا (يحوي كل الترحيلات، وآمن
   لإعادة التشغيل). إن أردت الملفات الحديثة فقط فنفّذ بالترتيب
   `db/migrations/supabase/0004_escalation_owner_support.sql` ثم
   `db/migrations/supabase/0006_escalate_manual_overload.sql`.
3. تأكّد من النتيجة: آخر الملف يطبع `NOTICE` بكل حملات `ofoq_client_escalate`
   الموجودة؛ يجب أن ترى واحدة بأربعة وسائط وواحدة بتسعة. لو ظهرت الأربع فقط فنّفذ
   `0004` أولًا (التطبيق يستدعي التسعة).
4. لا حاجة لإعادة النشر لأجل SQL، لكن أعد نشر Netlify بعد دمج الفرع لتفعيل
   السجلات ونقطة الفحص.

## الاختبار

1. سجّل الدخول بحساب عميل (مثل `alobdai8@gmail.com`) واكتب للمساعد:
   «أريد التحدث مع شخص حقيقي».
   - يجب أن يظهر الرد: «✔ تم تحويل محادثتك إلى فريق أفق البشري…».
   - افتح `/admin` → قسم **أحدث الطلبات** يظهر التنبيه (URGENT، طلب فريق بشري).
2. كرّر من حساب المالك (`amjadalobd1234@gmail.com`) — يجب أن تعمل الحالة نفسها.
3. أعد إرسال العبارة مرتين في نفس اليوم: تنبيه واحد فقط (`dedupe_key`)،
   ورسالة بريد واحدة.
4. لو ظهرت رسالة «تعذّر تسجيل تنبيه التحويل» مجددًا:
   - افتح `/api/debug/escalation` وأنت مسجّل الدخول، أو `/debug` قسم 8.
   - راجع الحقول: `caller.role`، `caller.hasCustomerRecord`،
     `conversation.ownedByCaller`، `alerts.tableExists`، `alerts.customerIdNullable`،
     `escalateFunctionExists`.
   - راجع سجلّ Netlify (Functions) عن سطر يبدأ بـ `[escalation]`:
     ```
     {"level":"error","message":"[escalation] alert row was not written",
      "userId":"…","role":"OWNER","customerId":null,"conversationId":"…",
      "code":"42501","error":"…","hint":"…"}
     ```
     الحقل `hint` يحدّد الخطوة التالية مباشرةً.

## خطأ `42883`: «الدالة `ofoq_client_escalate(text, text, text, text)` غير موجودة»

```
ERROR: 42883: function public.ofoq_client_escalate(text, text, text, text) does not exist
```

هذا الرقم **لا يعني أن شيئًا غير مثبّت**. معناه: «لا توجد دالة بهذا الاسم وبهذا العدد من
الوسائط». الدالة المثبّتة منذ `0003` والمُعاد كتابتها في `0004` تأخذ **تسعة** وسائط، وهي
نفسها التي يستدعيها التطبيق:

```sql
ofoq_client_escalate(p_conversation_id, p_category, p_severity,
                     p_title_ar, p_title_en, p_body_ar, p_body_en,
                     p_reason, p_signals)
```

وللتحقّق من أن هذا هو الاستدعاء الفعلي فابحث في `src/lib/services/escalation.service.ts`
(دالة `raiseClientEscalation`) — **لا** في `src/lib/agents/escalation-agent.ts`: هذا الملف الأخير
نقيّ تمامًا، يقرّر *هل* يصعّد ويبني الحمولة، ولا يلمس Supabase إطلاقًا.

لذلك أضف `db/migrations/supabase/0006_escalate_manual_overload.sql` **حملًا رابع وسائط**
للاختبار اليدوي؛ هو غلاف يسند إلى الدالة الأصلية ولا يكتب `alerts` بنفسه. تطبيقه لا يغيّر
سلوك التطبيق إطلاقًا، ويجعل الاختبار من SQL Editor ممكنًا بالشكل المختصر.

ولمعرفة ما هو مثبّت فعلًا في مشروعك:

```sql
SELECT p.proname || '(' || pg_get_function_arguments(p.oid) || ')' AS signature
FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'ofoq_client_escalate';
```

### الاختبار اليدوي من SQL Editor

الدالة تحلّ المتصل عبر `auth.uid()`، وفي SQL Editor **لا توجد جلسة**، فتجيب `28000
Authentication required or account inactive` لأي من الحملين. أعطِ الجلسة مستخدمًا أولًا،
وانتبه إلى أن `SET LOCAL` يحتاج معاملة مفتوحة:

```sql
BEGIN;
  SET LOCAL request.jwt.claims = '{"sub":"<users.id لحساب ACTIVE>","role":"authenticated"}';

  -- من هو هذا الحساب وهل يستطيع التصعيد؟
  SELECT public.ofoq_escalation_diagnostics();

  -- الحمل الرباعي الذي أضافه 0006
  SELECT public.ofoq_client_escalate(
    '<conversations.id وقناته WEB>', 'HUMAN_REQUEST', 'اختبار يدوي', 'URGENT'
  );
ROLLBACK;
```

`<users.id>` يجوز أن يكون للمالك: منذ `0004` أي `OWNER`/`PARTNER` فعّال يصعّد أي محادثة ويب.
الـ `ROLLBACK` مقصود — بلا تصعيد التنبيهات مقيّدة بـ `dedupe_key` (تنبيه واحد لكل محادثة
وتصنيف في اليوم)، والاختبار المتكرر لن يعيد البريد ما دام التنبيه مفتوحًا.

### صلاحيات `alerts` المباشرة (ما استُخدم عليه اسم «0005»)

`GRANT INSERT, SELECT, UPDATE ON public.alerts TO authenticated` **ليس مطلوبًا** للتصعيد ولا
لهذا الحمل: الدالة `SECURITY DEFINER` وتكتب بصلاحية المالك، والجدول يبقى مقفلًا بالـ GRANT
المسحوب في `0001` عن قصد — المسار الوحيد للكتابة هو الـ RPC المدقَّق. استخدام `authenticated`
المباشر للجدول يبقى كما هو في `describeAlertInsertError`: **فحص تشخيصي** في `/debug`، لا مسار
كتابة بديل. لو أبقيت تلك الصلاحية على المشروع الحي فاحرص على ترحيلها إلى ملف في
`db/migrations/supabase/` حتى يبقى المشروع الجديد قابلًا للاستنساخ.

## ملاحظة أمنية

- كل دوال التصعيد `SECURITY DEFINER` بدون `service_role`، وتتحقق من الجلسة
  والدور داخل SQL، والوصول المباشر للجداول مسحوب من `anon`/`authenticated`.
- سياسة الإدخال على `alerts` لا تفتح ثغرة: بدون `GRANT INSERT` يبقى الإدخال
  المباشر مرفوضًا (`permission denied for table alerts`)، وعند منح الصلاحية
  تجربةً تقبل السياسة صفوف التصعيد فقط وترفض أي صفّ آخر.
