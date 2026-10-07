/**
 * Application error types and their HTTP mapping.
 *
 * Route handlers catch `AppError` subclasses and translate them into consistent
 * JSON error payloads; anything else becomes a 500 with a request id so support
 * can correlate the report with the server log.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTEGRATION_DISABLED"
  | "PRECONDITION_FAILED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid input", details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, 422, details);
    this.name = "ValidationError";
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", message, 401);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: Record<string, unknown>) {
    super("CONFLICT", message, 409, details);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends AppError {
  constructor(message = "Too many requests, please try again shortly", retryAfterSeconds = 60) {
    super("RATE_LIMITED", message, 429, { retryAfterSeconds });
    this.name = "RateLimitedError";
  }
}

/**
 * Thrown when code reaches an integration that is intentionally not connected
 * yet (Google Ads, WhatsApp, online card payments). Never fatal: the platform
 * keeps working and the caller shows setup instructions.
 */
export class IntegrationDisabledError extends AppError {
  constructor(
    public readonly provider: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super("INTEGRATION_DISABLED", message, 503, details);
    this.name = "IntegrationDisabledError";
  }
}

export class PreconditionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("PRECONDITION_FAILED", message, 412, details);
    this.name = "PreconditionError";
  }
}

export interface ErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

export function toErrorPayload(error: unknown, requestId?: string): ErrorPayload {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL",
      message: "Something went wrong on our side. The issue has been logged.",
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function statusForError(error: unknown): number {
  if (error instanceof AppError) return error.status;
  return 500;
}
