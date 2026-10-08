import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "تواصل معنا" };
export default async function ContactPage() { return <MarketingInfoPage section="contact" locale={await getLocale()} />; }
