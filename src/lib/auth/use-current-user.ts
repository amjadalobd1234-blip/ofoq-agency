"use client";

import { useEffect, useState } from "react";

import type { UserRole } from "@/lib/domain/types";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: string;
  locale: string;
}

export type CurrentUserState =
  | { phase: "loading" }
  | { phase: "anonymous" }
  | { phase: "error"; message: string }
  | { phase: "ready"; user: CurrentUser };

/**
 * Loads the signed-in user's profile from `/api/me`.
 * `anonymous` means there is no valid session (HTTP 401).
 */
export function useCurrentUser(): CurrentUserState {
  const [state, setState] = useState<CurrentUserState>({ phase: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/me", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          setState({ phase: "anonymous" });
          return;
        }
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.data) {
          setState({ phase: "error", message: payload.error || "Unable to load your account." });
          return;
        }
        setState({ phase: "ready", user: payload.data as CurrentUser });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ phase: "error", message: "Unable to reach the server. Check your connection and try again." });
        }
      });

    return () => controller.abort();
  }, []);

  return state;
}
