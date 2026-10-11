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
   لإعادة التشغيل). إن أردت الملف الجديد فقط فنفّذ
   `db/migrations/supabase/0004_escalation_owner_support.sql`.
3. لا حاجة لإعادة النشر لأجل SQL، لكن أعد نشر Netlify بعد دمج الفرع لتفعيل
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

## ملاحظة أمنية

- كل دوال التصعيد `SECURITY DEFINER` بدون `service_role`، وتتحقق من الجلسة
  والدور داخل SQL، والوصول المباشر للجداول مسحوب من `anon`/`authenticated`.
- سياسة الإدخال على `alerts` لا تفتح ثغرة: بدون `GRANT INSERT` يبقى الإدخال
  المباشر مرفوضًا (`permission denied for table alerts`)، وعند منح الصلاحية
  تجربةً تقبل السياسة صفوف التصعيد فقط وترفض أي صفّ آخر.
