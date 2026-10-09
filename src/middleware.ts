import { NextResponse } from "next/server";

export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/login", "/register", "/forgot-password", "/reset-password", "/dashboard/:path*", "/chat", "/admin/:path*"],
};
