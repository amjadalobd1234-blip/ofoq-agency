import { AdminDashboard } from "@/components/admin-dashboard";
import { PlatformFrame } from "@/components/platform-frame";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "لوحة الإدارة" };

export default async function AdminPage() {
  const locale = await getLocale();
  const ar = locale === "ar";
  return (
    <PlatformFrame locale={locale} staff active="admin" title={ar ? "لوحة المالك والشريك" : "Owner and partner dashboard"} description={ar ? "مركز المراقبة يعرض بيانات تشغيل فعلية دون اختلاق عملاء أو نتائج." : "The control room shows real operational data without fabricated clients or results."}>
      <AdminDashboard locale={locale} />
    </PlatformFrame>
  );
}
