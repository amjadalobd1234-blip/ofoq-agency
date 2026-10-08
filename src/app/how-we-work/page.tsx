import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "كيف نعمل" };
export default async function HowWeWorkPage() { return <MarketingInfoPage section="howWeWork" locale={await getLocale()} />; }
