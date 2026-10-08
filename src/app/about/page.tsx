import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "عن أفق" };
export default async function AboutPage() { return <MarketingInfoPage section="about" locale={await getLocale()} />; }
