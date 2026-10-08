import { AuthForm } from "@/components/auth-form";
import { AuthScreen } from "@/components/auth-screen";
import { getLocale } from "@/lib/i18n";

export const metadata = { title: "استعادة كلمة المرور" };

export default async function ForgotPasswordPage() {
  const locale = await getLocale();
  return (
    <AuthScreen locale={locale}>
      <AuthForm mode="forgot" locale={locale} />
    </AuthScreen>
  );
}
