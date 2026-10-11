"use client";

import { AdminAccessGate } from "@/components/admin-access-gate";
import { AdminDashboard } from "@/components/admin-dashboard";

/**
 * /admin — owner and partner control room.
 *
 * `AdminAccessGate` keeps the shell hidden until the browser knows the user is
 * staff. The dashboard data comes from the `ofoq_admin_dashboard` RPC, which
 * independently checks the role in the database.
 */
export default function AdminPage() {
  return (
    <AdminAccessGate
      title={{ ar: "لوحة المالك والشريك", en: "Owner and partner dashboard" }}
      description={{
        ar: "مركز المراقبة يعرض بيانات تشغيل فعلية دون اختلاق عملاء أو نتائج.",
        en: "The control room shows real operational data without fabricated clients or results.",
      }}
      showIntegrationsShortcut
    >
      {({ locale }) => <AdminDashboard locale={locale} />}
    </AdminAccessGate>
  );
}
