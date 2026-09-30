import type { RouteCandidate, TripInfo } from "./types";

// ---------------------------------------------------------------------------
// Feasibility / time-conflict checks
// ---------------------------------------------------------------------------

/**
 * Parse a "HH:MM[:SS]" string into minutes since midnight.
 * Null/undefined/malformed input falls back to 0 rather than NaN so callers
 * never propagate NaN into feasibility arithmetic.
 */
export function timeToMinutes(time: string | null | undefined): number {
  if (!time) return 0;
  const parts = time.split(":");
  const h = parseInt(parts[0] ?? "0", 10);
  const m = parseInt(parts[1] ?? "0", 10);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * Check if a driver state can feasibly do a candidate route.
 *
 * AM routes only have a drop-off deadline (scheduled_end_time = school bell).
 * PM routes only have a pickup time (scheduled_start_time = school dismissal).
 *
 * `bufferMinutes` is the configured traffic buffer between routes, passed
 * explicitly so this function has no hidden dependency on module-level
 * config state.
 */
export function isFeasible(
  available_after: number,
  tripInfo: TripInfo,
  candidate: RouteCandidate,
  periodType: "AM" | "PM",
  bufferMinutes: number,
): boolean {
  const departureTime = available_after + bufferMinutes;
  const routeAnchor = periodType === "AM" ? candidate.end_minutes : candidate.start_minutes;
  if (periodType === "AM") {
    return departureTime + tripInfo.trip.totalMinutes <= routeAnchor;
  } else {
    const schoolArrivalOk = departureTime + (tripInfo.travelToSchoolMinutes ?? 0) <= routeAnchor;
    const dropoffMinutes = Math.max(tripInfo.trip.totalMinutes - (tripInfo.travelToSchoolMinutes ?? 0), 0);
    const dropoffFinishOk = routeAnchor + dropoffMinutes <= candidate.end_minutes;
    return schoolArrivalOk && dropoffFinishOk;
  }
}
