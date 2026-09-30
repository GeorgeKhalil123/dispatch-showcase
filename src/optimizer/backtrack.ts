import { isFeasible } from "./feasibility";
import { stateAfterAssignment } from "./tripHelpers";
import { computeGreedySeed, type GreedySeedCandidate, type GreedySeedResult } from "./greedySeed";
import type { TripInfo } from "./types";

// ---------------------------------------------------------------------------
// Backtracking coverage-first solver for one period (AM or PM).
//
// Objective, in strict priority order:
//   1. maximize the number of FLEXIBLE candidates covered;
//   2. among equal coverage, minimize total miles;
//   3. among equal coverage and miles, minimize the max routes on any driver.
//
// A lower-mileage solution with worse coverage can never win: miles are only
// compared once coverage is tied.
//
// Fixed candidates (already-committed assignments) MUST be assigned to their
// designated driver; if one becomes infeasible in a branch (e.g. an earlier
// new assignment made the driver late) that whole branch is pruned. This lets
// new routes interleave before/between/after existing ones without ever
// orphaning a previously assigned route.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_ITERATIONS = 2_000_000;

// Tolerance for floating-point drift in currentMiles, which accumulates via
// repeated += / -= across up to max_iterations recursive calls.
const MILES_EPSILON = 1e-6;

export type SolverCandidate = GreedySeedCandidate;

export interface PeriodSolution {
  assignment: Map<number, { driverIdx: number; tripInfo: TripInfo }>;
  assignedCount: number; // flexible candidates covered
  totalMiles: number;    // flexible candidates only
  maxLoad: number;
  seed: GreedySeedResult | null;
  iterations: number;
  timedOut: boolean;
}

/**
 * `allCandidates` must already be sorted by anchor time (AM: bell /
 * end_minutes, PM: dismissal / start_minutes). `homeTrips[driver][ci]` is the
 * trip from a driver's home; `interRouteTrips[prevCi][ci]` is the trip from
 * the end of candidate prevCi. Both are indexed identically to allCandidates.
 */
export function solvePeriod(
  allCandidates: SolverCandidate[],
  driverCount: number,
  homeTrips: TripInfo[][],
  interRouteTrips: TripInfo[][],
  periodType: "AM" | "PM",
  bufferMinutes: number,
  maxIterations: number = DEFAULT_MAX_ITERATIONS,
): PeriodSolution {
  const flexibleCount = allCandidates.filter((sc) => !sc.fixed).length;

  // Precompute suffix count of flexible candidates for pruning
  const flexibleSuffix: number[] = new Array(allCandidates.length + 1).fill(0);
  for (let i = allCandidates.length - 1; i >= 0; i--) {
    flexibleSuffix[i] = flexibleSuffix[i + 1] + (allCandidates[i].fixed ? 0 : 1);
  }

  let bestSolution: Map<number, { driverIdx: number; tripInfo: TripInfo }> = new Map();
  let bestCount = 0;
  let bestMiles = Infinity;
  let bestMaxLoad = Infinity;

  // Greedy nearest-driver seed pass — see greedySeed.ts. Seeds the incumbent
  // with a feasible baseline so the search below prunes far more aggressively
  // and, if it hits the iteration cap, still returns something at least as
  // good as the seed rather than an arbitrary partial branch.
  const seed = computeGreedySeed(allCandidates, driverCount, homeTrips, interRouteTrips, periodType, bufferMinutes);
  if (seed) {
    bestSolution = seed.assignment;
    bestCount = seed.flexibleCount;
    bestMiles = seed.totalMiles;
    bestMaxLoad = seed.maxLoad;
  }

  // Only availability and the chain of assigned candidates affect feasibility;
  // the end location of a driver is implied by its last assigned candidate.
  interface SolverDriverState {
    available_after: number;
    assignments: number[]; // candidate indices into allCandidates
  }
  const solverStates: SolverDriverState[] = Array.from({ length: driverCount }, () => ({
    available_after: 0,
    assignments: [],
  }));

  // Track routes per driver for load-balance tie-breaking
  const routesPerDriver = new Array<number>(driverCount).fill(0);

  let currentMiles = 0; // only tracks flexible candidate miles
  let iterations = 0;
  let timedOut = false;

  const tripFor = (di: number, ci: number): TripInfo => {
    const ss = solverStates[di];
    if (ss.assignments.length === 0) return homeTrips[di][ci];
    return interRouteTrips[ss.assignments[ss.assignments.length - 1]][ci];
  };

  const backtrack = (
    candidateIdx: number,
    currentAssignment: Map<number, { driverIdx: number; tripInfo: TripInfo }>,
    assignedCount: number, // only flexible candidates
  ): void => {
    if (++iterations > maxIterations) { timedOut = true; return; }

    // Prune 1: even if we assign ALL remaining flexible candidates, can we beat best?
    if (assignedCount + flexibleSuffix[candidateIdx] < bestCount) return;

    // Prune 2: perfect flexible solution exists and this branch already has more miles.
    if (bestCount === flexibleCount && currentMiles >= bestMiles + MILES_EPSILON) return;

    // Base case: processed all candidates
    if (candidateIdx >= allCandidates.length) {
      const maxLoad = Math.max(0, ...routesPerDriver);
      const betterCoverage = assignedCount > bestCount;
      const sameCoverageLessMiles = assignedCount === bestCount && currentMiles < bestMiles - MILES_EPSILON;
      const sameCoverageSameMilesLessLoad = assignedCount === bestCount && Math.abs(currentMiles - bestMiles) <= MILES_EPSILON && maxLoad < bestMaxLoad;
      if (betterCoverage || sameCoverageLessMiles || sameCoverageSameMilesLessLoad) {
        bestCount = assignedCount;
        bestMiles = currentMiles;
        bestMaxLoad = maxLoad;
        bestSolution = new Map(currentAssignment);
      }
      return;
    }

    const sc = allCandidates[candidateIdx];

    // Place candidateIdx on driver di, recurse, then undo.
    const tryDriver = (di: number, countsTowardCoverage: boolean): boolean => {
      const ss = solverStates[di];
      const tripInfo = tripFor(di, candidateIdx);
      if (!isFeasible(ss.available_after, tripInfo, sc.candidate, periodType, bufferMinutes)) return false;

      const savedAvail = ss.available_after;
      const savedLen = ss.assignments.length;
      ss.available_after = stateAfterAssignment(sc.candidate, tripInfo, periodType, ss.available_after, bufferMinutes).available_after;
      ss.assignments.push(candidateIdx);

      const tripMiles = !countsTowardCoverage || tripInfo.trip.totalMiles === Infinity ? 0 : tripInfo.trip.totalMiles;
      currentMiles += tripMiles;
      routesPerDriver[di]++;
      currentAssignment.set(candidateIdx, { driverIdx: di, tripInfo });
      backtrack(candidateIdx + 1, currentAssignment, assignedCount + (countsTowardCoverage ? 1 : 0));
      currentAssignment.delete(candidateIdx);
      routesPerDriver[di]--;
      currentMiles -= tripMiles;

      ss.available_after = savedAvail;
      ss.assignments.length = savedLen;
      return true;
    };

    if (sc.fixed) {
      // Fixed candidate: MUST be assigned to its designated driver. If
      // infeasible in this branch, the branch is invalid — prune it. Fixed
      // routes still count toward the load tie-break so a driver who already
      // has several preserved routes isn't treated as equally "free".
      tryDriver(sc.fixedDriverIdx, false);
      return;
    }

    // Flexible candidate: try assigning to each driver...
    for (let di = 0; di < driverCount; di++) tryDriver(di, true);
    // ...and try skipping it (no driver assigned).
    backtrack(candidateIdx + 1, currentAssignment, assignedCount);
  };

  backtrack(0, new Map(), 0);

  return {
    assignment: bestSolution,
    assignedCount: bestCount,
    totalMiles: bestMiles === Infinity ? 0 : bestMiles,
    maxLoad: bestMaxLoad === Infinity ? 0 : bestMaxLoad,
    seed,
    iterations,
    timedOut,
  };
}
