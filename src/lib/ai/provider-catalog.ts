/**
 * Live model-catalogue helpers.
 *
 * Every provider in `providers.ts` speaks the OpenAI-compatible protocol, and
 * all of them expose `GET {baseUrl}/models`. That endpoint answers the question
 * a retired model ID keeps raising — "does MY key still see this model?" — with
 * the owner's real credentials, instead of a documentation guess.
 *
 * This module is pure except for `fetchProviderModels`, which takes the fetch
 * implementation as an argument so tests never leave the process.
 */
import {
  getAiProvider,
  isConfigured,
  providerApiKey,
  providerStatuses,
  type AiProviderConfig,
} from "@/lib/ai/providers";

export interface LiveModelReport {
  id: string;
  name: string;
  configured: boolean;
  /** Models this project calls, default first. */
  declaredModels: string[];
  /** Model IDs the provider returns for this key, or null when unreachable. */
  liveModels: string[] | null;
  /** Declared models the provider did not list: the next connection-test failure. */
  missingDeclared: string[];
  /** Present only when the catalogue call itself failed. */
  error?: string;
}

/** Providers differ in spelling: Gemini prefixes ids with "models/". */
export function normaliseModelId(id: string): string {
  return id.trim().replace(/^models\//, "");
}

/**
 * Pulls model IDs out of the shapes the five providers return:
 * `{ data: [{ id }] }` (Groq, NVIDIA, OpenRouter, Gemini), `{ models: [...] }`
 * (Cohere v2) or a bare array.
 */
export function extractModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? ((payload as { data?: unknown }).data ?? (payload as { models?: unknown }).models)
      : null;

  if (!Array.isArray(list)) return [];

  return list
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const candidate = (entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name;
        if (typeof candidate === "string") return candidate;
      }
      return "";
    })
    .map(normaliseModelId)
    .filter((id) => id.length > 0);
}

/** Declared models that the live catalogue does not contain (order preserved). */
export function missingModels(declared: string[], live: string[]): string[] {
  const available = new Set(live.map(normaliseModelId));
  return declared.filter((model) => !available.has(normaliseModelId(model)));
}

/**
 * Reads one provider's catalogue with that provider's key.
 *
 * Never throws: a provider that is unreachable or unauthorised is reported as a
 * failure of THIS check, which is itself the useful answer.
 */
export async function fetchProviderModels(
  provider: AiProviderConfig,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<{ ids: string[] | null; error?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const apiKey = providerApiKey(provider);
  if (!apiKey) return { ids: null, error: "No API key is configured for this provider." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ids: null, error: `HTTP ${response.status} from ${provider.baseUrl}/models.` };
    }
    const ids = extractModelIds(await response.json());
    return ids.length > 0 ? { ids } : { ids: null, error: "The provider returned an empty catalogue." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ids: null, error: message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Full report for the owner screen: one row per provider, in priority order. */
export async function liveModelReport(
  options: { providerId?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<LiveModelReport[]> {
  const statuses = providerStatuses().filter(
    (status) => !options.providerId || status.id === options.providerId,
  );

  return Promise.all(
    statuses.map(async (status) => {
      const configured = isConfigured(status.id);
      if (!configured) {
        return {
          id: status.id,
          name: status.name,
          configured,
          declaredModels: status.models,
          liveModels: null,
          missingDeclared: [],
          error: `Add ${status.apiKeyEnv} to check this provider.`,
        };
      }

      const provider = getAiProvider(status.id) as AiProviderConfig;
      const { ids, error } = await fetchProviderModels(provider, options);
      return {
        id: status.id,
        name: status.name,
        configured,
        declaredModels: status.models,
        liveModels: ids,
        missingDeclared: ids ? missingModels(status.models, ids) : [],
        ...(error ? { error } : {}),
      };
    }),
  );
}
