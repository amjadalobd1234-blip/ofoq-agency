/**
 * Structured logging.
 *
 * One JSON line per event on stdout/stderr so logs can be shipped to any
 * collector. Secrets are never logged: values are passed through `redact`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[_-]?key|authorization|cookie|card|cvv)/i;

function levelThreshold(): number {
  const configured = (process.env.LOG_LEVEL ?? "").toLowerCase() as LogLevel;
  if (configured in LEVEL_ORDER) return LEVEL_ORDER[configured];
  return process.env.NODE_ENV === "production" ? LEVEL_ORDER.info : LEVEL_ORDER.debug;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split("\n").slice(0, 4) };
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = "[redacted]";
        continue;
      }
      output[key] = redact(item, depth + 1);
    }
    return output;
  }
  return value;
}

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

function write(level: LogLevel, message: string, context: LogContext, bindings: LogContext): void {
  if (LEVEL_ORDER[level] < levelThreshold()) return;
  const payload = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...(Object.keys(bindings).length ? { ...(redact(bindings) as object) } : {}),
    ...(Object.keys(context).length ? (redact(context) as object) : {}),
  });
  if (level === "error") {
    process.stderr.write(`${payload}\n`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

export function createLogger(bindings: LogContext = {}): Logger {
  return {
    debug: (message, context = {}) => write("debug", message, context, bindings),
    info: (message, context = {}) => write("info", message, context, bindings),
    warn: (message, context = {}) => write("warn", message, context, bindings),
    error: (message, context = {}) => write("error", message, context, bindings),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

export const logger = createLogger({ service: "ofoq" });
