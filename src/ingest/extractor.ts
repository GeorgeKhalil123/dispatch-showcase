import { z } from "zod";
import type { ExtractedRoute } from "../shared/types";
import {
  dedupeRows,
  extractRouteCode,
  flagScore,
  needsReview,
  normalizeRow,
  type RawExtractedRow,
} from "./confidence";

// ---------------------------------------------------------------------------
// Extraction seam. The full system extracts rows from PDFs with a multi-pass
// model pipeline (private). Everything downstream of that — scoring, dedup,
// review routing — is shown here, driven by a stub that returns canned rows.
// ---------------------------------------------------------------------------

/** One row as the field passes return it: values plus the flags they raised. */
export interface FieldPassRow {
  child_name: string | null;
  home_address: string | null;
  school_address: string | null;
  school_start_time: string | null;
  school_end_time: string | null;
  requires_accommodation: boolean;
  flags: string[];
}

// Runtime shape check for rows parsed from untrusted content. Missing fields
// default to "not extracted" so they surface as review flags downstream.
const fieldPassRowSchema = z.object({
  child_name: z.string().nullable().default(null),
  home_address: z.string().nullable().default(null),
  school_address: z.string().nullable().default(null),
  school_start_time: z.string().nullable().default(null),
  school_end_time: z.string().nullable().default(null),
  requires_accommodation: z.boolean().default(false),
  flags: z.array(z.string()).default([]),
});

/** The document parsed but its rows don't have the expected shape. */
export class ExtractionError extends Error {
  override name = "ExtractionError";
}

export interface Extractor {
  extract(filename: string, content: string): Promise<FieldPassRow[]>;
}

/**
 * TOY EXTRACTOR — no model call. Returns canned rows keyed by filename, or
 * parses `content` as a JSON array of rows when no canned entry exists.
 */
export class StubExtractor implements Extractor {
  constructor(private readonly canned: Record<string, FieldPassRow[]> = {}) {}

  async extract(filename: string, content: string): Promise<FieldPassRow[]> {
    // hasOwn, not a truthiness check: filenames like "constructor" or
    // "__proto__" would otherwise resolve to Object.prototype members.
    if (Object.hasOwn(this.canned, filename)) return structuredClone(this.canned[filename]);
    if (!content.trim()) return [];
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) throw new ExtractionError("content must be a JSON array of rows");
    const rows = z.array(fieldPassRowSchema).safeParse(parsed);
    if (!rows.success) {
      const details = rows.error.issues
        .map((issue) => `row ${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new ExtractionError(`invalid row(s): ${details}`);
    }
    return rows.data;
  }
}

export interface ExtractionPreview {
  filename: string;
  total_extracted: number;
  needs_review: number;
  routes: ExtractedRoute[];
  warnings: string[];
}

/**
 * Run the extractor and the review-routing pipeline. Nothing is written
 * anywhere: the preview is what the reviewer sees before committing.
 */
export async function previewExtraction(
  extractor: Extractor,
  filename: string,
  content: string,
): Promise<ExtractionPreview> {
  const warnings: string[] = [];
  const rows = await extractor.extract(filename, content);
  const routeCode = extractRouteCode(filename);

  // Aggregate each row's field-pass flags into the model score, then
  // normalize (completeness score, missing-field flags, final min()).
  const normalized = rows.map((row) => {
    const raw: RawExtractedRow = { ...row, confidence: flagScore(row.flags ?? []) };
    return normalizeRow(raw, routeCode);
  });

  const { routes, merged } = dedupeRows(normalized);
  if (merged > 0) {
    warnings.push(`Cross-chunk deduplication merged ${merged} duplicate record(s)`);
  }
  if (routes.length === 0) {
    warnings.push("No student rows were extracted from this document");
  }

  return {
    filename,
    total_extracted: routes.length,
    needs_review: routes.filter(needsReview).length,
    routes,
    warnings,
  };
}
