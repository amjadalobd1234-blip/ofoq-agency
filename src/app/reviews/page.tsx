import { MarketingInfoPage } from "@/components/marketing-info-page";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "تقييمات العملاء" };
export default async function ReviewsPage() { return <MarketingInfoPage section="reviews" locale={await getLocale()} />; }
