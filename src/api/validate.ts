import { Request, Response, NextFunction } from "express";

export type HttpError = Error & { status?: number };

/**
 * Builds an Error with an attached HTTP status for `next(err)`. Centralizes
 * the `const err: Error & {status?:number} = ...; err.status = ...` pattern
 * that route handlers otherwise hand-roll individually.
 */
export function httpError(message: string, status = 400): HttpError {
  const err: HttpError = new Error(message);
  err.status = status;
  return err;
}

const makeError = httpError;

/**
 * Returns Express middleware that checks req.body for the given required fields.
 * Responds with 400 and a list of missing fields if any are absent.
 */
export function requireFields(...fields: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const missing = fields.filter(
      (f) => req.body[f] === undefined || req.body[f] === null || req.body[f] === ""
    );

    if (missing.length > 0) {
      return next(makeError(`Missing required fields: ${missing.join(", ")}`));
    }

    next();
  };
}

/**
 * Returns a new object containing only the `allowed` keys from `body`.
 * Guards insert/update calls against mass assignment — protected columns
 * (`id`, `created_at`, `updated_at`) and unknown keys in the request body are
 * silently dropped instead of reaching the database.
 */
export function pickFields<T extends string>(
  body: unknown,
  allowed: readonly T[]
): Record<T, unknown> {
  const picked: Record<string, unknown> = {};
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of allowed) {
      if (key in record) picked[key] = record[key];
    }
  }
  return picked as Record<T, unknown>;
}

/**
 * Validates that `req.body[field]` is a string in ISO date form (YYYY-MM-DD)
 * or a full ISO 8601 timestamp that parses cleanly via `Date`. Skips when the
 * field is absent — pair with `requireFields` when the field is mandatory.
 */
export function validateDate(field: string) {
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/;
  return (req: Request, _res: Response, next: NextFunction) => {
    const value = req.body[field];
    if (value === undefined || value === null || value === "") return next();
    if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
      return next(makeError(`Invalid date for field "${field}": expected ISO format (YYYY-MM-DD)`));
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return next(makeError(`Invalid date for field "${field}": unparseable`));
    }
    next();
  };
}

/**
 * Validates that `req.body[field]` is a member of the allowed `values` set.
 * Skips when the field is absent — pair with `requireFields` when mandatory.
 */
export function validateEnum<T extends string>(field: string, values: readonly T[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const value = req.body[field];
    if (value === undefined || value === null || value === "") return next();
    if (!values.includes(value)) {
      return next(
        makeError(
          `Invalid value for field "${field}": expected one of ${values.join(", ")}`
        )
      );
    }
    next();
  };
}

/**
 * Validates that `req.body[field]` is a finite number > 0. Accepts numeric
 * strings (they are coerced via `Number`). Skips when the field is absent —
 * pair with `requireFields` when mandatory.
 */
export function validatePositiveNumber(field: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.body[field];
    if (raw === undefined || raw === null || raw === "") return next();
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return next(makeError(`Invalid value for field "${field}": expected positive number`));
    }
    next();
  };
}
