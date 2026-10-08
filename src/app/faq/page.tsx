import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "الأسئلة الشائعة" };
export default async function FaqPage() { return <MarketingInfoPage section="faq" locale={await getLocale()} />; }
