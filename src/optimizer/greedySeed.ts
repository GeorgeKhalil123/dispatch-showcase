import { isFeasible } from "./feasibility";
import { stateAfterAssignment } from "./tripHelpers";
import type { RouteCandidate, TripInfo } from "./types";

// ---------------------------------------------------------------------------
// Greedy nearest-driver seed pass
//
// solve()'s backtracking solver caps itself at max_iterations and,
// on large inputs, can time out before finding a full-coverage assignment —
// previously this meant it silently returned whatever partial solution the
// (empty-seeded) search had reached, which could be far from optimal.
//
// This pass runs BEFORE backtracking and greedily assigns each candidate (in
// the same time-anchored order the solver uses) to the nearest feasible
// driver (by trip miles), honoring "fixed" (already-existing/preserved)
// assignments as mandatory. The result seeds the solver's `bestSolution` /
// `bestCount` / `bestMiles` / `bestMaxLoad`, so:
//   - the backtracking search starts from a good (often full-coverage)
//     baseline instead of zero, letting its pruning short-circuit far more
//     aggressively and converge well within the iteration cap;
//   - if the search still times out, the fallback result is at least as good
//     as the greedy seed instead of an arbitrary partial branch.
//
// Every invariant the backtracking solver enforces is preserved here:
//   - fixed (existing/preserved) candidates are mandatory — if the greedy
//     order can't honor one feasibly, the whole seed is discarded (returns
//     null) and the solver falls back to its original from-scratch search,
//     so a bad greedy path can never violate "never orphan a previously
//     assigned route".
//   - flagged (special-accommodation) routes are never part of `candidates`
//     upstream in solve(), so they never reach this pass either.
//   - AM/PM pairing is enforced by the caller after both periods run (in the
//     full system; the pairing pass is not part of this extract) — this pass
//     only picks drivers, it doesn't touch pairing.
// ---------------------------------------------------------------------------

export interface GreedySeedCandidate {
  candidate: RouteCandidate;
  fixed: boolean;
  fixedDriverIdx: number; // only meaningful when fixed === true
}

export interface GreedySeedResult {
  /** Map of candidate index -> assignment, matching the shape the
   *  backtracking solver's `currentAssignment`/`bestSolution` maps use. */
  assignment: Map<number, { driverIdx: number; tripInfo: TripInfo }>;
  /** Count of FLEXIBLE candidates covered (mirrors `assignedCount` / `bestCount`). */
  flexibleCount: number;
  /** Total miles across flexible candidates only (mirrors `currentMiles` / `bestMiles`). */
  totalMiles: number;
  /** Max routes assigned to any single driver (mirrors the solver's load tie-breaker). */
  maxLoad: number;
}

/**
 * Compute a greedy nearest-driver seed assignment for one period (AM or PM).
 *
 * `allCandidates` must be in the exact same order used by the backtracking
 * solver (fixed + flexible, sorted by anchor time), and `homeTrips` /
 * `interRouteTrips` must be the same pre-computed (and TravelTimeProvider-filled)
 * trip-info matrices the solver uses, indexed identically.
 *
 * Returns null if a fixed candidate cannot be feasibly honored while
 * following this greedy order — in that case the seed would be invalid
 * (it could not actually occur in the backtracking search), so callers
 * should skip seeding and let the solver run unassisted, exactly as before
 * this pass existed.
 */
export function computeGreedySeed(
  allCandidates: GreedySeedCandidate[],
  driverCount: number,
  homeTrips: TripInfo[][],
  interRouteTrips: TripInfo[][],
  periodType: "AM" | "PM",
  bufferMinutes: number,
): GreedySeedResult | null {
  interface GreedyDriverState {
    available_after: number;
    lastAssignedCi: number; // -1 = still at home
  }

  const states: GreedyDriverState[] = Array.from({ length: driverCount }, () => ({
    available_after: 0,
    lastAssignedCi: -1,
  }));

  const assignment = new Map<number, { driverIdx: number; tripInfo: TripInfo }>();
  const routesPerDriver = new Array<number>(driverCount).fill(0);
  let flexibleCount = 0;
  let totalMiles = 0;

  const tripInfoFor = (di: number, ci: number): TripInfo => {
    const st = states[di];
    return st.lastAssignedCi === -1 ? homeTrips[di][ci] : interRouteTrips[st.lastAssignedCi][ci];
  };

  for (let ci = 0; ci < allCandidates.length; ci++) {
    const sc = allCandidates[ci];

    if (sc.fixed) {
      // Mandatory: must be assigned to its designated driver. If infeasible
      // in this greedy ordering, the whole seed is unusable (the true
      // solver would prune this branch entirely rather than skip it).
      const di = sc.fixedDriverIdx;
      const st = states[di];
      const tripInfo = tripInfoFor(di, ci);

      if (!isFeasible(st.available_after, tripInfo, sc.candidate, periodType, bufferMinutes)) {
        return null;
      }

      const after = stateAfterAssignment(sc.candidate, tripInfo, periodType, st.available_after, bufferMinutes);
      st.available_after = after.available_after;
      st.lastAssignedCi = ci;
      assignment.set(ci, { driverIdx: di, tripInfo });
      // Count fixed (existing/preserved) assignments toward maxLoad too,
      // matching the backtracking solver's load tie-break so a driver who
      // already has several preserved routes isn't seeded as equally "free"
      // as an idle driver.
      routesPerDriver[di]++;
      continue;
    }

    // Flexible: assign to whichever feasible driver is nearest (fewest miles).
    let bestDi = -1;
    let bestTripInfo: TripInfo | null = null;
    let bestMiles = Infinity;
    for (let di = 0; di < driverCount; di++) {
      const st = states[di];
      const tripInfo = tripInfoFor(di, ci);
      if (!isFeasible(st.available_after, tripInfo, sc.candidate, periodType, bufferMinutes)) continue;
      const miles = tripInfo.trip.totalMiles;
      if (miles < bestMiles) {
        bestMiles = miles;
        bestDi = di;
        bestTripInfo = tripInfo;
      }
    }

    if (bestDi === -1 || !bestTripInfo) {
      // No feasible driver for this candidate — leave it unassigned in the
      // seed (the backtracking search may still find room for it).
      continue;
    }

    const st = states[bestDi];
    const after = stateAfterAssignment(sc.candidate, bestTripInfo, periodType, st.available_after, bufferMinutes);
    st.available_after = after.available_after;
    st.lastAssignedCi = ci;
    assignment.set(ci, { driverIdx: bestDi, tripInfo: bestTripInfo });

    flexibleCount++;
    routesPerDriver[bestDi]++;
    totalMiles += bestTripInfo.trip.totalMiles === Infinity ? 0 : bestTripInfo.trip.totalMiles;
  }

  const maxLoad = Math.max(0, ...routesPerDriver);
  return { assignment, flexibleCount, totalMiles, maxLoad };
}
