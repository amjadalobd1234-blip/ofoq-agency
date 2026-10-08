# أفق | Ofoq

منصة لإدارة وكالة تسويق رقمي. تعمل SQLite محلياً، وتدعم PostgreSQL للإنتاج.

## البدء محلياً

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

تحقق من تشغيل الخادم عبر `http://localhost:3000/api/health`. تتوفر صفحة تعريفية على المسار `/`. قاعدة SQLite هي الخيار الافتراضي؛ لا تحتاج إلى Supabase للتطوير المحلي.

## Supabase وVercel

- دليل النشر العربي: [docs/DEPLOY-AR.md](docs/DEPLOY-AR.md)
- إعداد Supabase SQL: [docs/setup/supabase-setup.sql](docs/setup/supabase-setup.sql)
- لتوليد ملفات PostgreSQL بعد تحديث مخطط SQLite: `npm run db:generate-postgres`

لا تضع `DATABASE_URL` أو أي سر في Git أو في كود المتصفح.
