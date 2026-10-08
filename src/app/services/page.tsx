import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "الخدمات" };
export default async function ServicesPage() { return <MarketingInfoPage section="services" locale={await getLocale()} />; }
