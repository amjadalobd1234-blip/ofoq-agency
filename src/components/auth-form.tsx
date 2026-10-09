"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import type { Locale } from "@/lib/domain/types";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export type AuthMode = "login" | "register" | "forgot" | "reset";

export function AuthForm({ mode, locale, nextPath = "/dashboard" }: {
  mode: AuthMode;
  locale: Locale;
  nextPath?: string;
}) {
  const copy = dictionaries[locale];
  const auth = copy.auth;
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const configured = isSupabaseConfigured();
  const isArabic = locale === "ar";

  const labels = {
    title: mode === "login" ? auth.loginTitle : mode === "register" ? auth.registerTitle : mode === "forgot" ? auth.resetTitle : auth.setPassword,
    submit: mode === "login" ? auth.login : mode === "register" ? auth.register : mode === "forgot" ? auth.resetSubmit : auth.setPassword,
    description: mode === "forgot" ? auth.resetBody : mode === "reset" ? (isArabic ? "اختر كلمة مرور جديدة لحسابك." : "Choose a new password for your account.") : null,
  };

  function tellError(error: unknown) {
    // Fix: show real Supabase error details — error.message, error.code, error.status
    // Example requested: setError(`خطأ: ${error.message} (code: ${error.code})`)
    const supabaseError = error as {
      message?: string;
      code?: string;
      status?: number;
      statusCode?: number;
      name?: string;
      __isAuthError?: boolean;
    } | null;
    const message =
      typeof supabaseError?.message === "string" && supabaseError.message.length > 0
        ? supabaseError.message
        : error instanceof Error
          ? error.message
          : String(error ?? "");
    const code =
      typeof supabaseError?.code === "string" && supabaseError.code.length > 0
        ? supabaseError.code
        : (supabaseError as Record<string, unknown> | null)?.error_code as string | undefined;
    const status =
      typeof supabaseError?.status === "number"
        ? supabaseError.status
        : typeof supabaseError?.statusCode === "number"
          ? supabaseError.statusCode
          : undefined;
    const raw = message.toLowerCase();
    let text: string;
    const isNetworkFailure =
      supabaseError?.name === "TypeError" ||
      supabaseError?.name === "NetworkError" ||
      /failed to fetch|networkerror|fetch failed|load failed|network request failed/.test(raw);
    if (isNetworkFailure) {
      text = isArabic
        ? "فشل الاتصال بخادم Supabase قبل وصول الطلب (Failed to fetch) — هذه ليست مشكلة بيانات. السبب الأشهر: مزود الإنترنت يحجب نطاق supabase.co (كما في العراق). الحل: تفعيل الوسيط NEXT_PUBLIC_SUPABASE_PROXY_URL=/api/supabase-proxy في Netlify وإعادة النشر — أو مشروع Supabase متوقف (Paused) في اللوحة. افتح صفحة /debug للتأكد (اختبارات proxy: هي الفيصل)."
        : "The connection to Supabase failed before the request was sent (Failed to fetch) — this is not a data problem. The most common cause: your ISP blocks the supabase.co domain (as in Iraq). Fix: enable the NEXT_PUBLIC_SUPABASE_PROXY_URL=/api/supabase-proxy proxy in Netlify and redeploy — or the Supabase project is Paused in the dashboard. Open /debug to confirm (the proxy: tests are decisive).";
    } else if (raw.includes("invalid login") || raw.includes("invalid_credentials")) text = auth.invalidCredentials;
    else if (raw.includes("already registered") || raw.includes("user already exists")) {
      text = isArabic ? "تعذر إنشاء الحساب. إذا كان لديك حساب مسبقًا، سجّل الدخول أو استعد كلمة المرور." : "We could not create that account. If you already have one, sign in or reset your password.";
    } else if (raw.includes("email not confirmed")) {
      text = isArabic ? "تحقق من بريدك الإلكتروني أولًا، ثم سجّل الدخول." : "Please verify your email before signing in.";
    } else if (raw.includes("password should be at least") || raw.includes("weak password")) {
      text = isArabic ? "اختر كلمة مرور أقوى (٨ أحرف على الأقل)." : "Choose a stronger password (at least 8 characters).";
    } else if (raw.includes("provider is not enabled") || raw.includes("unsupported provider")) {
      text = isArabic ? "تسجيل Google غير مفعّل في إعدادات Supabase بعد." : "Google sign-in has not been enabled in Supabase yet.";
    } else {
      text = isArabic ? "تعذّر إتمام الطلب. تحقق من البيانات وحاول مرة أخرى." : "We could not complete that request. Check your details and try again.";
    }
    // Show the real Supabase diagnostic so we can distinguish CSP / API key / validation failures.
    // Keep the friendly text above, but always append the technical details for debugging.
    // eslint-disable-next-line no-console
    console.error("[auth-form] Supabase error:", { message, code, status, raw: error });
    const diagnostics = `message: ${message || "—"} | code: ${code ?? "—"} | status: ${status ?? "—"}`;
    const nameSuffix =
      typeof supabaseError?.name === "string" && supabaseError.name !== "Error" ? ` | name: ${supabaseError.name}` : "";
    // Also surface the raw error.message/code/status explicitly as requested:
    // خطأ: ${error.message} (code: ${error.code}, status: ${error.status})
    const debugLine = isArabic
      ? `خطأ: ${message || "—"} (code: ${code ?? "—"}, status: ${status ?? "—"})`
      : `Error: ${message || "—"} (code: ${code ?? "—"}, status: ${status ?? "—"})`;
    setNotice({ kind: "error", text: `${text} — ${diagnostics}${nameSuffix} — ${debugLine}` });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    if (!configured) return;
    if ((mode === "register" || mode === "reset") && password.length < 8) {
      setNotice({ kind: "error", text: isArabic ? "كلمة المرور يجب أن تتكون من ٨ أحرف على الأقل." : "Password must be at least 8 characters." });
      return;
    }
    if ((mode === "register" || mode === "reset") && password !== confirmation) {
      setNotice({ kind: "error", text: isArabic ? "كلمتا المرور غير متطابقتين." : "The passwords do not match." });
      return;
    }

    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        router.replace(nextPath);
        router.refresh();
      } else if (mode === "register") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: name.trim(), locale },
            emailRedirectTo: `${window.location.origin}/auth/callback?next=/chat`,
          },
        });
        if (error) throw error;
        if (data.session) {
          router.replace("/chat");
          router.refresh();
        } else {
          setNotice({ kind: "success", text: auth.verifySent });
        }
      } else if (mode === "forgot") {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
        });
        if (error) throw error;
        // Same response for known and unknown addresses.
        setNotice({ kind: "success", text: auth.resetSent });
      } else {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setNotice({ kind: "success", text: isArabic ? "تم تحديث كلمة المرور. يمكنك الدخول الآن." : "Your password was updated. You can sign in now." });
        window.setTimeout(() => router.replace("/dashboard"), 700);
      }
    } catch (error) {
      tellError(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setNotice(null);
    const supabase = createSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(mode === "register" ? "/chat" : nextPath)}` },
      });
      if (error) throw error;
    } catch (error) {
      tellError(error);
      setBusy(false);
    }
  }

  return (
    <div className="auth-form-wrap">
      <div className="auth-form-heading">
        <span className="eyebrow">{isArabic ? "حسابك في أفق" : "YOUR OFOQ ACCOUNT"}</span>
        <h1>{labels.title}</h1>
        {labels.description && <p>{labels.description}</p>}
      </div>

      {!configured && (
        <div className="setup-notice" role="status">
          <span className="setup-notice-icon" aria-hidden="true">!</span>
          <div>
            <strong>{isArabic ? "تسجيل الدخول غير مفعّل بعد" : "Sign-in is not configured yet"}</strong>
            <p>{isArabic ? "أضف NEXT_PUBLIC_SUPABASE_URL وNEXT_PUBLIC_SUPABASE_ANON_KEY إلى إعدادات البيئة، ثم أعد تشغيل التطبيق." : "Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to the environment, then restart the app."}</p>
          </div>
        </div>
      )}

      {notice && (
        <div className={`form-notice form-notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
        </div>
      )}

      <form className="auth-form" onSubmit={handleSubmit}>
        {mode === "register" && (
          <label className="form-field">
            <span>{auth.name}</span>
            <input autoComplete="name" name="name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        )}

        {mode !== "reset" && (
          <label className="form-field">
            <span>{auth.email}</span>
            <input autoComplete="email" dir="ltr" type="email" name="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
        )}

        {mode !== "forgot" && (
          <label className="form-field">
            <span>{mode === "reset" ? auth.newPassword : auth.password}</span>
            <input autoComplete={mode === "login" ? "current-password" : "new-password"} dir="ltr" type="password" name="password" required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
        )}

        {(mode === "register" || mode === "reset") && (
          <label className="form-field">
            <span>{auth.confirmPassword}</span>
            <input autoComplete="new-password" dir="ltr" type="password" name="password-confirmation" required minLength={8} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
          </label>
        )}

        <button className="button button-gold auth-submit" type="submit" disabled={busy || !configured}>
          <span>{busy ? copy.common.loading : labels.submit}</span>
          <span className="button-arrow" aria-hidden="true">↗</span>
        </button>
      </form>

      {(mode === "login" || mode === "register") && (
        <>
          <div className="auth-separator"><span>{auth.or}</span></div>
          <button className="google-button" type="button" onClick={handleGoogle} disabled={busy || !configured}>
            <GoogleIcon />
            <span>{auth.googleSignIn}</span>
          </button>
          <p className="auth-google-note">{isArabic ? "يتطلب تسجيل Google تفعيل المزوّد في إعدادات Supabase." : "Google sign-in requires the provider to be enabled in Supabase settings."}</p>
        </>
      )}

      {mode === "login" && <a className="auth-text-link auth-forgot" href="/forgot-password">{auth.forgot}</a>}
      {mode === "login" && <p className="auth-switch">{auth.noAccount} <a href="/register">{auth.register}</a></p>}
      {mode === "register" && <p className="auth-switch">{auth.hasAccount} <a href="/login">{auth.login}</a></p>}
      {mode === "forgot" && <p className="auth-switch"><a href="/login">{auth.login}</a></p>}
      {mode === "reset" && <p className="auth-switch"><a href="/login">{auth.login}</a></p>}

      <p className="auth-security-note">
        <span aria-hidden="true">◇</span>
        {isArabic ? "حسابك محمي عبر Supabase Auth. لا نطلب بيانات بطاقة الدفع في المحادثة." : "Your account is secured with Supabase Auth. We never ask for payment-card details in chat."}
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.1v5.1h6.6c3.9-3.6 6.1-8.8 6.1-14.9Z" />
      <path fill="#FF3D00" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.5H5.8v5.3C9.2 39.5 16 44 24 44Z" />
      <path fill="#4CAF50" d="M12.6 27.6a12 12 0 0 1 0-7.2v-5.3H5.8a20 20 0 0 0 0 17.8l6.8-5.3Z" />
      <path fill="#1976D2" d="M24 11.9c3 0 5.7 1 7.8 3.1l5.9-5.9C34.1 5.8 29.5 4 24 4 16 4 9.2 8.5 5.8 15.1l6.8 5.3c1.6-4.9 6.1-8.5 11.4-8.5Z" />
    </svg>
  );
}
