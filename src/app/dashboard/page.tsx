import { ClientDashboard } from "@/components/client-dashboard";
import { PlatformFrame } from "@/components/platform-frame";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "بوابة العميل" };

export default async function DashboardPage() {
  const locale = await getLocale();
  const ar = locale === "ar";
  return (
    <PlatformFrame locale={locale} active="dashboard" title={ar ? "بوابة العميل" : "Client portal"} description={ar ? "مشاريعك وطلباتك وفواتيرك في مكان واحد." : "Your projects, requests and invoices in one place."}>
      <ClientDashboard locale={locale} />
    </PlatformFrame>
  );
}
