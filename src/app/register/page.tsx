import { AuthForm } from "@/components/auth-form";
import { AuthScreen } from "@/components/auth-screen";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "إنشاء حساب" };

export default async function RegisterPage() {
  const locale = await getLocale();
  return (
    <AuthScreen locale={locale}>
      <AuthForm mode="register" locale={locale} />
    </AuthScreen>
  );
}
