import { AssistantChat } from "@/components/assistant-chat";
import { PlatformFrame } from "@/components/platform-frame";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "محادثة مساعد أفق" };

type PageProps = { searchParams?: Promise<{ intent?: string | string[] }> };

export default async function ChatPage({ searchParams }: PageProps) {
  const locale = await getLocale();
  const params = (await searchParams) ?? {};
  const intentValue = Array.isArray(params.intent) ? params.intent[0] : params.intent;
  const intent = intentValue === "service_request" ? intentValue : undefined;
  const ar = locale === "ar";
  return (
    <PlatformFrame locale={locale} active="chat" title={ar ? "محادثة مساعد أفق" : "Chat with the Ofoq assistant"} description={ar ? "مساعد ذكي تابع للوكالة. أخبرنا باحتياجك وسنرشدك خطوة بخطوة." : "An AI assistant of the agency. Tell us what you need and we will guide you step by step."}>
      <AssistantChat locale={locale} intent={intent} />
    </PlatformFrame>
  );
}
