import type { ExtractedRoute } from "../shared/types";

// ---------------------------------------------------------------------------
// Review routing for extracted manifest rows.
//
// Nothing extracted from a document is ever committed automatically. Each row
// gets a confidence score built from two independent signals, and any row
// that is low-confidence OR carries a flag is routed to the human review
// queue before it can reach the database.
// ---------------------------------------------------------------------------

export const REVIEW_THRESHOLD = 0.7;

/**
 * Per-row score from the extraction passes' own flags. Each field pass
 * calibrates its flags independently, so more flags across passes means less
 * certainty overall: 0.9 with no flags, minus 0.1 per flag, floored at 0.4.
 */
export function flagScore(flags: readonly string[]): number {
  return flags.length === 0 ? 0.9 : Math.max(0.4, 0.9 - flags.length * 0.1);
}

/** Missing critical fields, as the human-readable flags the review UI shows. */
export function missingFieldFlags(r: Pick<ExtractedRoute, "child_name" | "home_address" | "school_address" | "school_start_time" | "school_end_time">): string[] {
  const missing: string[] = [];
  if (!r.child_name) missing.push("Missing child name");
  if (!r.home_address) missing.push("Missing home address");
  if (!r.school_address) missing.push("Missing school address");
  if (!r.school_start_time) missing.push("Missing start time");
  if (!r.school_end_time) missing.push("Missing end time");
  return missing;
}

/** Field completeness score — each missing critical field costs 0.15. */
export function completenessScore(missingCount: number): number {
  return Math.max(0, 1 - missingCount * 0.15);
}

/** Shape an extractor hands back before normalization. Everything is optional. */
export interface RawExtractedRow {
  child_name?: string | null;
  home_address?: string | null;
  school_address?: string | null;
  school_start_time?: string | null;
  school_end_time?: string | null;
  requires_accommodation?: boolean;
  confidence?: unknown;
  flags?: unknown;
}

/**
 * Normalize one raw row. Final confidence is the LOWER of the completeness
 * score and the model score — both must be high for a green result. A model
 * score under the threshold also gets an explicit "Model uncertainty" flag
 * so the reviewer can see why the row was queued.
 */
export function normalizeRow(r: RawExtractedRow, routeCode: string | null): ExtractedRoute {
  const normalized: ExtractedRoute = {
    child_name: r.child_name ?? null,
    home_address: r.home_address ?? null,
    school_address: r.school_address ?? null,
    school_start_time: normalizeTime(r.school_start_time),
    school_end_time: normalizeTime(r.school_end_time),
    requires_accommodation: Boolean(r.requires_accommodation),
    confidence: 1,
    flags: Array.isArray(r.flags) ? r.flags.filter((f): f is string => typeof f === "string") : [],
    route_code: routeCode,
  };

  const missing = missingFieldFlags(normalized);
  const fieldScore = completenessScore(missing.length);

  // Model accuracy score — how certain the extractor was about what it did extract
  const modelScore = typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.5;
  if (modelScore < REVIEW_THRESHOLD && !normalized.flags.some((f) => f.toLowerCase().includes("uncertain"))) {
    normalized.flags.push(`Model uncertainty: ${Math.round(modelScore * 100)}%`);
  }

  normalized.confidence = Math.min(fieldScore, modelScore);

  // Add missing-field flags that aren't already present
  for (const m of missing) {
    if (!normalized.flags.includes(m)) normalized.flags.push(m);
  }

  return normalized;
}

export function needsReview(r: Pick<ExtractedRoute, "confidence" | "flags">): boolean {
  return r.confidence < REVIEW_THRESHOLD || r.flags.length > 0;
}

/**
 * Cross-chunk deduplication: a row near a page break can be extracted twice.
 * Match on (child_name + home_address), case-insensitive and
 * whitespace-normalized. Keep the higher-confidence record in the position of
 * the first-seen one, and union both records' flags.
 */
export function dedupeRows(routes: ExtractedRoute[]): { routes: ExtractedRoute[]; merged: number } {
  const dedupKey = (r: ExtractedRoute): string | null => {
    const name = (r.child_name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    const addr = (r.home_address ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!name && !addr) return null;
    return `${name}||${addr}`;
  };

  const byKey = new Map<string, ExtractedRoute>();
  const deduped: ExtractedRoute[] = [];
  let merged = 0;
  for (const r of routes) {
    const key = dedupKey(r);
    if (!key) {
      deduped.push(r);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, r);
      deduped.push(r);
      continue;
    }
    merged++;
    const winner = r.confidence > existing.confidence ? r : existing;
    const loser = winner === r ? existing : r;
    const flags = [...new Set([...existing.flags, ...loser.flags, ...winner.flags])];
    Object.assign(existing, { ...winner, flags });
  }
  return { routes: deduped, merged };
}

/**
 * Route code from the first alphanumeric token of a document's filename.
 * e.g. "RT104 Morning.pdf" → "RT104"
 */
export function extractRouteCode(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, "").trim();
  if (!base) return null;
  const firstToken = base.split(/\s+/)[0];
  if (!firstToken) return null;
  return /^[A-Za-z0-9]+$/.test(firstToken) ? firstToken : null;
}

export function normalizeTime(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();

  // Already in HH:MM format
  if (/^\d{2}:\d{2}$/.test(trimmed)) return trimmed;

  // H:MM → HH:MM
  if (/^\d{1}:\d{2}$/.test(trimmed)) return `0${trimmed}`;

  // Try to parse AM/PM
  const match = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = match[2];
    const period = (match[3] || "").toLowerCase().replace(/\./g, "");
    if (period === "pm" && hours < 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    if (hours >= 0 && hours <= 23) {
      return `${String(hours).padStart(2, "0")}:${minutes}`;
    }
  }

  return null;
}
