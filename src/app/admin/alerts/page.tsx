"use client";

import { AdminAccessGate } from "@/components/admin-access-gate";
import { AdminAlertList } from "@/components/admin-alert-list";

/** Staff-only, pageable alert inbox. Data comes from ofoq_admin_alerts. */
export default function AdminAlertsPage() {
  return (
    <AdminAccessGate
      title={{ ar: "كل التنبيهات", en: "All alerts" }}
      description={{
        ar: "تابع تنبيهات الفريق، وراجع سياق كل حالة، ثم سجل المتابعة أو الحل.",
        en: "Follow team alerts, review each case in context, then record follow-up or resolution.",
      }}
    >
      {({ locale }) => <AdminAlertList locale={locale} />}
    </AdminAccessGate>
  );
}
