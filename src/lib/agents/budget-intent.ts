/**
 * Budget intent for the guided service request — layer 2 (AI), used only when
 * the pattern layer (`budget-parser.ts`) could not read a budget out of the
 * client's message («خمسمية دولار», «نص ألف تقريباً», «بين المئتين والخمسمية»).
 *
 * The AI provider chain starts with Groq (`GROQ_API_KEY`). The model is asked
 * for one thing only: the amount or range the client states, as JSON. Whatever
 * comes back is validated here (finite positive numbers, a sane ceiling, USD or
 * no currency) and normalised through the same `budgetFromAmounts` helper as
 * the patterns, so both layers store the identical `200-500` shape.
 *
 * Never throws: a provider problem simply means "no budget found", and the
 * caller shows the options again — no random value is ever saved.
 */
import { chat } from "@/lib/ai/ai-service";
import { logger } from "@/lib/core/logger";

import {
  MAX_BUDGET_AMOUNT,
  MIN_BUDGET_AMOUNT,
  budgetFromAmounts,
  looksLikePhoneNumber,
  normalizeBudgetText,
  parseBudgetText,
  type ParsedBudget,
} from "./budget-parser";

export interface BudgetIntentResolution {
  budget: ParsedBudget | null;
  /** Which layer produced the answer: the local patterns, the AI, or nothing. */
  source: "local" | "ai" | "none";
  provider?: string;
  model?: string;
}

const SYSTEM_PROMPT = [
  "You extract the marketing budget a client states in one message, for the Ofoq agency assistant (Iraq; Arabic, Iraqi dialect, or English).",
  'Answer with JSON only, exactly: {"min": <number|null>, "max": <number|null>, "currency": "USD"|"IQD"|null}',
  "Rules:",
  "  - A single amount («ميزانيتي 350», «خمسمية دولار») → min = max = that amount.",
  "  - A range («من 200 إلى 500», «بين 200 و 500», «200-500») → min = lower bound, max = upper bound, whatever order the client used.",
  "  - Number words count: مية=100، مئتين=200، ثلاثمية=300، خمسمية=500، ألف=1000، نص ألف=500، 1k=1000.",
  "  - «$», «دولار», «usd» → USD. «دينار», «د.ع», «IQD» → IQD. No currency named → null.",
  '  - If the message states no budget, or the number is clearly something else (a phone number, a date, a number of posts or days), answer {"min":null,"max":null,"currency":null}.',
  "Never invent an amount. Never add text outside the JSON object.",
].join("\n");

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(normalizeBudgetText(value).replace(/[^\d.]/g, ""));
    return Number.isFinite(parsed) && value.trim() !== "" ? parsed : null;
  }
  return null;
}

/**
 * Validates a model answer. Accepts a JSON object (optionally fenced) with
 * `min`/`max`, and keeps it only when the amounts are positive, sane and not
 * stated in another currency.
 */
export function parseBudgetAnswer(answer: string): ParsedBudget | null {
  const raw = (answer ?? "").trim();
  if (!raw) return null;
  const withoutFence = raw.replace(/```(?:json)?/gi, " ").trim();
  const jsonStart = withoutFence.indexOf("{");
  const jsonEnd = withoutFence.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence.slice(jsonStart, jsonEnd + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  const currencyRaw = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
  if (currencyRaw && currencyRaw !== "USD" && currencyRaw !== "$") return null;

  const min = toNumber(record.min ?? record.amount ?? record.value);
  const max = toNumber(record.max ?? record.amount ?? record.value);
  const amounts = [min, max].filter((value): value is number => value !== null && value >= MIN_BUDGET_AMOUNT && value <= MAX_BUDGET_AMOUNT);
  if (amounts.length === 0) return null;
  // One missing bound → a single value; both present → a range, order-independent.
  const first = Math.round(amounts[0]!);
  const second = amounts.length > 1 ? Math.round(amounts[1]!) : null;
  if (first < MIN_BUDGET_AMOUNT || (second !== null && second < MIN_BUDGET_AMOUNT)) return null;
  return budgetFromAmounts(first, second, currencyRaw ? "USD" : null);
}

/** Asks the AI provider chain (Groq first) for the budget stated in a message. */
export async function extractBudgetIntent(
  message: string,
): Promise<{ budget: ParsedBudget | null; provider?: string; model?: string }> {
  const text = message.trim().slice(0, 800);
  if (!text) return { budget: null };

  try {
    const result = await chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      {
        agentKey: "budget-intent",
        temperature: 0,
        maxTokens: 80,
        timeoutMs: 10_000,
        json: true,
      },
    );
    return { budget: parseBudgetAnswer(result.text), provider: result.provider, model: result.model };
  } catch (error) {
    logger.warn("Budget-intent extraction failed; asking the client to pick a budget option", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { budget: null };
  }
}

/**
 * Hybrid resolution: the deterministic patterns first, the AI as the fallback.
 * `budget: null` means the client must be shown the budget options again.
 */
export async function resolveBudgetIntent(
  message: string,
  options: { bareNumbers?: boolean } = {},
): Promise<BudgetIntentResolution> {
  const local = parseBudgetText(message, { bareNumbers: options.bareNumbers });
  if (local) return { budget: local, source: "local" };
  // A WhatsApp number typed at the wrong moment is not a budget; no model needed.
  if (looksLikePhoneNumber(message)) return { budget: null, source: "none" };

  const ai = await extractBudgetIntent(message);
  if (ai.budget) return { budget: ai.budget, source: "ai", provider: ai.provider, model: ai.model };
  return { budget: null, source: "none", provider: ai.provider, model: ai.model };
}
