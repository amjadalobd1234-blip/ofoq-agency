import { AuthForm } from "@/components/auth-form";
import { AuthScreen } from "@/components/auth-screen";
import { getLocale } from "@/lib/i18n";
import { safeLocalPath } from "@/lib/security/local-path";

export const metadata = { title: "تسجيل الدخول" };

type PageProps = { searchParams?: Promise<{ next?: string | string[] }> };

export default async function LoginPage({ searchParams }: PageProps) {
  const locale = await getLocale();
  const params = (await searchParams) ?? {};
  const candidate = Array.isArray(params.next) ? params.next[0] : params.next;
  const nextPath = safeLocalPath(candidate);

  return (
    <AuthScreen locale={locale}>
      <AuthForm mode="login" locale={locale} nextPath={nextPath} />
    </AuthScreen>
  );
}
