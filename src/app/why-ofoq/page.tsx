import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "لماذا أفق" };
export default async function WhyOfoqPage() { return <MarketingInfoPage section="whyOfoq" locale={await getLocale()} />; }
