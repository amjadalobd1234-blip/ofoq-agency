import { getEnv } from "@/lib/config/env";
import { ValidationError } from "@/lib/core/errors";

/**
 * Google OAuth 2.0 (authorization code flow) used for:
 *   · client sign-in with Google,
 *   · (later) connecting the agency's Google Ads account.
 *
 * Implemented directly against Google's OAuth endpoints — no vendor SDK. The
 * flow stays disabled until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
 * State values are signed so a callback cannot be replayed across sessions.
 */
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export const GOOGLE_SIGNIN_SCOPES = ["openid", "email", "profile"];
export const GOOGLE_ADS_SCOPES = ["https://www.googleapis.com/auth/adwords"];

export function googleOAuthConfigured(): boolean {
  return getEnv().google.enabled;
}

export interface AuthUrlOptions {
  state: string;
  scopes?: string[];
  /** Always include offline access when a refresh token is required (Ads). */
  offline?: boolean;
  promptConsent?: boolean;
}

export function buildGoogleAuthUrl(options: AuthUrlOptions): string {
  const env = getEnv();
  if (!env.google.enabled) {
    throw new ValidationError(
      "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable it.",
    );
  }
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: env.google.redirectUri,
    response_type: "code",
    scope: (options.scopes ?? GOOGLE_SIGNIN_SCOPES).join(" "),
    state: options.state,
    include_granted_scopes: "true",
  });
  if (options.offline) {
    params.set("access_type", "offline");
  }
  if (options.promptConsent) {
    params.set("prompt", "consent");
  }
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  id_token?: string;
  token_type: string;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleTokenResponse> {
  const env = getEnv();
  if (!env.google.enabled) throw new ValidationError("Google OAuth is not configured");

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: env.google.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ValidationError(`Google rejected the authorization code (${response.status})`, {
      detail: detail.slice(0, 300),
    });
  }
  return (await response.json()) as GoogleTokenResponse;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new ValidationError(`Could not read the Google profile (${response.status})`);
  }
  const profile = (await response.json()) as GoogleProfile;
  if (!profile.sub || !profile.email) {
    throw new ValidationError("The Google profile did not include an email address");
  }
  return profile;
}

export function refreshTokenExpiry(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}
