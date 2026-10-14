/**
 * AI intent layer for the guided service request — every selection step.
 *
 * The rule matcher (`matchOption` in `service-request.ts`) only understands a
 * message that literally contains an option: «البصرة» matches «🌊 البصرة فقط»,
 * but «بصرا», «أريد أشتغل بالبصرة», «بغداد والبصرة», «بريد» or «المكان» match
 * nothing at all, and the client was shown the options again — the system saved
 * what it was told and understood nothing else.
 *
 * This layer is what runs when the rules fail. The model is given the step, the
 * question on screen and the published options of that step, and answers with
 * one value plus how sure it is:
 *
 *   {"match": "basra", "confidence": 0.95}
 *
 * The answer is then gated by `acceptStepIntent()` (same module the chat uses):
 * a published option of that step only, and a confidence of at least
 * `STEP_INTENT_MIN_CONFIDENCE` (0.7). Below that — or when the model names
 * something unpublished, answers «no match», or the provider fails — the result
 * is `null` and the caller shows the options again. Never throws, never guesses.
 *
 * The provider chain starts with Groq (`GROQ_API_KEY`), like the budget and the
 * TYPE intent layers.
 */
import { chat } from "@/lib/ai/ai-service";
import { logger } from "@/lib/core/logger";
import type { Locale } from "@/lib/domain/types";

import {
  acceptStepIntent,
  matchOption,
  serviceRequestMatchableOptions,
  type MatchableOption,
  type ServiceRequestQuestionStep,
  SERVICE_REQUEST_QUESTIONS,
} from "./service-request";

/** Every step that offers a choice, i.e. every step this layer can answer. */
export const STEP_INTENT_STEPS = ["TYPE", "SIZE", "BUDGET", "TARGETING", "CONTACT"] as const;

export interface StepIntentResolution {
  /** A published option id of the step, or `null` when the intent stayed unknown. */
  optionId: string | null;
  /** The confidence the model stated (0…1), or `null` when it stated none. */
  confidence: number | null;
  /** Which layer produced the answer: the local matcher, the AI, or nothing. */
  source: "local" | "ai" | "none";
  provider?: string;
  model?: string;
}

export interface StepIntentOptions {
  /** Narrows the published options the model may choose from (values only). */
  only?: readonly string[];
  /** Interface language of the conversation; the prompt quotes that question. */
  language?: Locale;
}

/**
 * The options the model may choose from: the step's published options, or the
 * subset of them a caller asked for. Values that are not published options of
 * the step are dropped, and a list with nothing valid left falls back to the
 * full published one — the model is never offered an option the flow cannot
 * store.
 */
export function stepIntentOptions(step: ServiceRequestQuestionStep, only?: readonly string[]): MatchableOption[] {
  const options = serviceRequestMatchableOptions(step);
  if (!only || only.length === 0) return options;
  const allowed = new Set(only.filter((value) => options.some((option) => option.value === value)));
  if (allowed.size === 0) return options;
  return options.filter((option) => allowed.has(option.value));
}

/**
 * The prompt of one step-intent call: the step, the question on screen, the
 * published options with both labels, and the shape of the answer. Exported so
 * the tests can assert the model is really given the options of that step.
 */
export function buildStepIntentPrompt(
  step: ServiceRequestQuestionStep,
  message: string,
  options: readonly MatchableOption[],
  language: Locale = "ar",
): { system: string; user: string } {
  const question = SERVICE_REQUEST_QUESTIONS[step];
  const system = [
    "You read what a client means in ONE message of the Ofoq agency guided service request (Iraq; clients write Arabic, Iraqi dialect, or English) and map it to exactly one of the published options of the step they are on.",
    "",
    `Step: ${step} — the question on screen is «${question.question[language]}»`,
    `Conversation language: ${language}`,
    "",
    "Published options — answer with one of these values, exactly as written:",
    ...options.map((option) => `  - ${option.value} → ${option.labelAr} | ${option.labelEn}`),
    "",
    'Answer with JSON only, exactly: {"match":"<value>","confidence":<number from 0 to 1>}',
    "Rules:",
    "  - Choose the option closest to the client's intent. Typos, dialect words, partial names and a choice named inside a longer sentence all count («بصرا» and «أريد أشتغل بالبصرة» → the Basra option, «بريد» → the e-mail option, «كل العراق» → the whole-Iraq option).",
    "  - When the message names two or three of the choices one option already covers, prefer that option over a single one of them.",
    "  - confidence is how sure you are: 0.9 and above the option is named outright, 0.7 to 0.9 a clear paraphrase, below 0.7 a guess.",
    '  - If no option fits — a greeting, a question about something else, an answer too vague to place — reply {"match":null,"confidence":0}.',
    "  - Never answer with a value that is not in the list. Never add text outside the JSON object.",
  ].join("\n");
  return { system, user: message };
}

export interface ParsedStepIntent {
  match: string | null;
  confidence: number | null;
}

/** Keys a model may use for the chosen option and for its confidence. */
const MATCH_KEYS = ["match", "optionId", "option_id", "option", "value", "result", "intent", "selected"] as const;
const CONFIDENCE_KEYS = ["confidence", "score", "certainty"] as const;

/**
 * Reads `{ "match": "<value>" | null, "confidence": 0.0-1.0 }` out of a model
 * answer: a JSON object (fenced or not), an object under other key names, or a
 * bare option id with no JSON around it. Anything unreadable is
 * `{ match: null, confidence: null }`, which the gate rejects.
 */
export function parseStepIntentAnswer(answer: string): ParsedStepIntent {
  const raw = (answer ?? "").trim();
  if (!raw) return { match: null, confidence: null };

  const withoutFence = raw.replace(/```(?:json)?/gi, " ").trim();
  const jsonStart = withoutFence.indexOf("{");
  const jsonEnd = withoutFence.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const parsed: unknown = JSON.parse(withoutFence.slice(jsonStart, jsonEnd + 1));
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        let match: string | null = null;
        for (const key of MATCH_KEYS) {
          const value = record[key];
          if (typeof value === "string" && value.trim()) {
            match = value.trim();
            break;
          }
        }
        let confidence: number | null = null;
        for (const key of CONFIDENCE_KEYS) {
          const value = record[key];
          const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
          if (Number.isFinite(numeric)) {
            confidence = numeric;
            break;
          }
        }
        // `{"match": null}` is an explicit "no option fits", not a missing answer.
        return { match, confidence: match === null ? (confidence ?? 0) : confidence };
      }
    } catch {
      // Not JSON after all: fall through to the bare-id reading.
    }
  }

  const bare = withoutFence.replace(/^["'`\s]+|["'`،.\s]+$/g, "").trim();
  if (!bare || /^null$/i.test(bare) || /\s/.test(bare)) return { match: null, confidence: null };
  // A direct answer with no JSON around it («basra»): the id still has to be a
  // published option, but it carries no doubt to weigh.
  return { match: bare, confidence: 1 };
}

/** Asks the model which option of `step` the message means, gated as described. */
async function askModel(
  step: ServiceRequestQuestionStep,
  message: string,
  list: readonly MatchableOption[],
  language: Locale,
): Promise<{ optionId: string | null; confidence: number | null; provider?: string; model?: string }> {
  const prompt = buildStepIntentPrompt(step, message, list, language);
  try {
    const result = await chat(
      [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      {
        agentKey: "step-intent",
        temperature: 0,
        maxTokens: 60,
        timeoutMs: 10_000,
        json: true,
      },
    );
    const parsed = parseStepIntentAnswer(result.text);
    return {
      optionId: acceptStepIntent(step, parsed.match, parsed.confidence, list),
      confidence: parsed.confidence,
      provider: result.provider,
      model: result.model,
    };
  } catch (error) {
    logger.warn("Step-intent extraction failed; asking the client to pick an option", {
      step,
      error: error instanceof Error ? error.message : String(error),
    });
    return { optionId: null, confidence: null };
  }
}

/**
 * The AI layer on its own — no rule matching first. Used by the tests and by
 * callers that already know the rules failed.
 */
export async function extractStepIntent(
  step: ServiceRequestQuestionStep,
  message: string,
  options: StepIntentOptions = {},
): Promise<{ optionId: string | null; confidence: number | null; provider?: string; model?: string }> {
  const text = message.trim().slice(0, 800);
  const list = stepIntentOptions(step, options.only);
  if (!text || list.length === 0) return { optionId: null, confidence: null };
  return askModel(step, text, list, options.language ?? "ar");
}

/**
 * Hybrid resolution for one selection step: the deterministic matcher first
 * (fast, free, and it already understands «البصرة» and «السعودية»), the AI
 * intent layer as the fallback. `optionId: null` means the client must be shown
 * the options again — nothing is saved on a guess.
 */
export async function resolveStepIntent(
  step: ServiceRequestQuestionStep,
  message: string,
  options: StepIntentOptions = {},
): Promise<StepIntentResolution> {
  const list = stepIntentOptions(step, options.only);
  const local = matchOption(message, list);
  if (local) return { optionId: local.value, confidence: 1, source: "local" };

  const text = message.trim().slice(0, 800);
  if (!text) return { optionId: null, confidence: null, source: "none" };

  const ai = await askModel(step, text, list, options.language ?? "ar");
  if (ai.optionId) {
    return { optionId: ai.optionId, confidence: ai.confidence, source: "ai", provider: ai.provider, model: ai.model };
  }
  return { optionId: null, confidence: ai.confidence, source: "none", provider: ai.provider, model: ai.model };
}
