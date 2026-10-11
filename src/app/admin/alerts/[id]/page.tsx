"use client";

import { useParams } from "next/navigation";

import { AdminAccessGate } from "@/components/admin-access-gate";
import { AdminAlertDetail } from "@/components/admin-alert-detail";

/** Staff-only alert detail, conversation reply and lifecycle actions. */
export default function AdminAlertDetailsPage() {
  const params = useParams<{ id: string | string[] }>();
  const routeId = Array.isArray(params.id) ? params.id[0] : params.id;
  const alertId = routeId?.trim() || "";

  return (
    <AdminAccessGate
      title={{ ar: "تفاصيل التنبيه", en: "Alert details" }}
      description={{
        ar: "سياق العميل والمحادثة وإجراءات المتابعة في مكان واحد.",
        en: "Client context, conversation and follow-up actions in one place.",
      }}
    >
      {({ locale }) => alertId ? <AdminAlertDetail alertId={alertId} locale={locale} /> : <InvalidAlertId locale={locale} />}
    </AdminAccessGate>
  );
}

function InvalidAlertId({ locale }: { locale: "ar" | "en" }) {
  const ar = locale === "ar";
  return <div className="setup-notice platform-notice" role="alert"><span className="setup-notice-icon">!</span><div><strong>{ar ? "معرّف التنبيه غير صالح" : "Invalid alert id"}</strong><p><a className="owner-admin-link" href="/admin/alerts">{ar ? "العودة إلى التنبيهات" : "Back to alerts"}</a></p></div></div>;
}
