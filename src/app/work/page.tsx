import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "أعمالنا" };
export default async function WorkPage() { return <MarketingInfoPage section="work" locale={await getLocale()} />; }
