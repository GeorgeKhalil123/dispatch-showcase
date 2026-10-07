import type { Request, Response, NextFunction } from "express";
import type { HttpError } from "./validate";

/**
 * Centralized Express error handler. Serializes `err.status` (default 500).
 * Stack traces are never sent unless explicitly opted in with DISPATCH_DEBUG=1,
 * and 5xx messages are masked when NODE_ENV === "production".
 * Register this as the LAST middleware in the app, after all routes.
 */
export function errorHandler(err: HttpError & { type?: string; body?: unknown }, _req: Request, res: Response, _next: NextFunction): void {
  // body-parser marks malformed JSON with type "entity.parse.failed" and status 400
  const status = err.status ?? 500;
  const body: { status: number; message: string; details?: { stack?: string } } = {
    status,
    message: status >= 500 && process.env.NODE_ENV === "production" ? "Internal server error" : err.message || "Internal server error",
  };
  // Strict mode rejects top-level primitives (5, "x", null) with a JSON.parse
  // style message that reads like a syntax error; say what is actually wrong.
  if (err.type === "entity.parse.failed" && typeof err.body === "string" && !/^\s*[{[]/.test(err.body)) {
    body.message = "Request body must be a JSON object";
  }
  if (process.env.DISPATCH_DEBUG === "1" && status >= 500) {
    body.details = { stack: err.stack };
  }
  res.status(status).json(body);
}
