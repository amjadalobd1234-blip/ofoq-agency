import { NextResponse, type NextRequest } from "next/server";

import { safeLocalPath } from "@/lib/security/local-path";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const nextPath = safeLocalPath(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const client = await createSupabaseServerClient();

  if (!client || !code) {
    return NextResponse.redirect(new URL("/login?auth=callback-error", request.url));
  }

  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/login?auth=callback-error", request.url));
  }

  return NextResponse.redirect(new URL(nextPath, request.url));
}
