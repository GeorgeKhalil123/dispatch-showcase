import { z, type ZodError } from "zod";
import type { HttpError } from "./validate";

/**
 * Convert a Zod validation failure into an Express-style `HttpError` carrying
 * `status = 400`, so it funnels through the shared error handler exactly like
 * the hand-rolled `next(err)` checks in validate.ts.
 *
 * The message lists each failing path + reason, e.g.
 *   "Validation failed: buffer_minutes: Too small: expected number to be >0"
 */
export function zodErrorToHttp(err: ZodError, prefix = "Validation failed"): HttpError {
  const details = err.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
  const httpErr: HttpError = new Error(`${prefix}: ${details}`);
  httpErr.status = 400;
  return httpErr;
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date: expected ISO format (YYYY-MM-DD).");

// Body of POST /optimize. Mirrors SolveConfig plus the date whose existing
// assignments should be preserved.
export const optimizeRequestSchema = z.object({
  date: isoDate,
  buffer_minutes: z.number().positive().max(120).optional(),
  preserve_existing: z.boolean().default(true),
  max_iterations: z.number().int().positive().max(10_000_000).optional(),
});

export type OptimizeRequestInput = z.infer<typeof optimizeRequestSchema>;

// Body of POST /import/preview. The real endpoint takes a multipart PDF; the
// showcase takes the filename plus the stub extractor's JSON content.
export const importPreviewSchema = z.object({
  filename: z.string().min(1, "'filename' must be a non-empty string.").max(255),
  content: z.string().max(1_000_000).default(""),
});

export type ImportPreviewInput = z.infer<typeof importPreviewSchema>;
