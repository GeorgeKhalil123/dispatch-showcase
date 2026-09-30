import type { Assignment, Driver, Route } from "../shared/types";
import { timeToMinutes } from "./feasibility";
import {
  buildTripDescription,
  computeTripInfo,
  getCandidateEndLocation,
  mergeCandidateGroup,
  stateAfterAssignment,
} from "./tripHelpers";
import { DEFAULT_MAX_ITERATIONS, solvePeriod, type SolverCandidate } from "./backtrack";
import type { Leg, TravelTimeProvider, Waypoint } from "./travelTime";
import type {
  OptimizationResult,
  PeriodDiagnostics,
  RouteAssignment,
  RouteCandidate,
  SolveConfig,
  StudentInfo,
  TripInfo,
  UnassignedRoute,
} from "./types";

// ---------------------------------------------------------------------------
// solve() — a trimmed version of the full system's optimize(). It keeps the
// algorithmic core (candidate merging, fixed/preserved assignments, provider
// pricing, greedy seed + backtracking per period) and takes plain data in
// place of database reads. Left out on purpose: AM/PM pairing enforcement,
// what-if scenarios, selective reassignment and cost calculation.
// ---------------------------------------------------------------------------

export interface RouteWithStudents {
  route: Route;
  students: StudentInfo[];
}

export interface SolveInput {
  drivers: Driver[];
  routes: RouteWithStudents[];
  existing?: Assignment[]; // already-committed assignments to preserve
}

// Explicit `undefined` (e.g. an omitted optional field forwarded from a
// request body) falls back to the default instead of overriding it — a plain
// object spread would let it through and turn every feasibility check to NaN.
function resolveConfig(config: Partial<SolveConfig>): Required<SolveConfig> {
  return {
    buffer_minutes: config.buffer_minutes ?? 10,
    max_iterations: config.max_iterations ?? DEFAULT_MAX_ITERATIONS,
  };
}

/**
 * Merge routes that share a route code, period, school and anchor time into a
 * single candidate a driver handles in one trip. Routes without a code are
 * never merged.
 */
export function buildCandidates(routes: RouteWithStudents[]): RouteCandidate[] {
  const groups = new Map<string, RouteCandidate[]>();
  for (const { route, students } of routes) {
    const candidate: RouteCandidate = {
      route,
      merged_route_ids: [route.id],
      students,
      start_minutes: timeToMinutes(route.scheduled_start_time),
      end_minutes: timeToMinutes(route.scheduled_end_time),
    };
    const anchor = route.type === "AM" ? candidate.end_minutes : candidate.start_minutes;
    const key = route.route_code
      ? `${route.type}|${route.route_code}|${route.school_address}|${anchor}`
      : `id|${route.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(candidate);
  }
  return [...groups.values()].map((g) => (g.length === 1 ? g[0] : mergeCandidateGroup(g)));
}

/** Ordered waypoints a trip is priced along: AM picks up then drops at school, PM the reverse. */
function tripChain(origin: Waypoint, candidate: RouteCandidate, periodType: "AM" | "PM"): Waypoint[] {
  const school: Waypoint = {
    address: candidate.route.school_address,
    lat: candidate.route.school_latitude ?? 0,
    lng: candidate.route.school_longitude ?? 0,
  };
  const homes: Waypoint[] = candidate.students
    .filter((s) => s.home_latitude !== null && s.home_longitude !== null)
    .map((s) => ({ address: s.home_address, lat: s.home_latitude!, lng: s.home_longitude! }));
  return periodType === "AM" ? [origin, ...homes, school] : [origin, school, ...homes];
}

/**
 * Price every (origin, candidate) trip with ONE provider call. Legs are
 * de-duplicated first so a leg shared by many chains is priced once.
 */
async function priceTrips(
  provider: TravelTimeProvider,
  origins: Waypoint[],
  candidates: SolverCandidate[],
  periodType: "AM" | "PM",
): Promise<TripInfo[][]> {
  const legIndex = new Map<string, number>();
  const legs: Leg[] = [];
  const key = (w: Waypoint) => `${w.lat},${w.lng}`;

  const chains = origins.map((origin) =>
    candidates.map((sc) => {
      const chain = tripChain(origin, sc.candidate, periodType);
      const ids: number[] = [];
      for (let i = 0; i + 1 < chain.length; i++) {
        const k = `${key(chain[i])}->${key(chain[i + 1])}`;
        if (!legIndex.has(k)) {
          legIndex.set(k, legs.length);
          legs.push({ from: chain[i], to: chain[i + 1] });
        }
        ids.push(legIndex.get(k)!);
      }
      return ids;
    }),
  );

  const estimates = legs.length > 0 ? await provider.estimateLegs(legs) : [];
  if (estimates.length !== legs.length) {
    throw new Error(`${provider.name}: expected ${legs.length} leg estimates, got ${estimates.length}`);
  }

  return origins.map((origin, oi) =>
    candidates.map((sc, ci) => {
      const ids = chains[oi][ci];
      const info = computeTripInfo(origin.lat, origin.lng, origin.address, sc.candidate, periodType);
      info.trip.totalMiles = ids.reduce((sum, id) => sum + estimates[id].miles, 0);
      info.trip.totalMinutes = ids.reduce((sum, id) => sum + estimates[id].minutes, 0);
      if (periodType === "PM") info.travelToSchoolMinutes = ids.length > 0 ? estimates[ids[0]].minutes : 0;
      return info;
    }),
  );
}

export async function solve(
  input: SolveInput,
  provider: TravelTimeProvider,
  config: Partial<SolveConfig> = {},
): Promise<OptimizationResult> {
  const cfg = resolveConfig(config);
  const warnings: string[] = [];
  const diagnostics: PeriodDiagnostics[] = [];

  const drivers = input.drivers.filter((d) => d.home_latitude !== null && d.home_longitude !== null);
  if (drivers.length < input.drivers.length) {
    warnings.push(`${input.drivers.length - drivers.length} driver(s) skipped — home address not geocoded`);
  }

  const allRoutes = input.routes.map((r) => r.route);
  if (drivers.length === 0) return emptyResult("No drivers available", allRoutes);
  if (allRoutes.length === 0) return emptyResult("No routes to assign", []);

  // Flagged (special-accommodation) routes are never auto-assigned.
  const flaggedCount = allRoutes.filter((r) => r.flagged).length;
  const assignable = input.routes.filter((r) => !r.route.flagged);

  // Existing assignments whose driver and route are still present become
  // FIXED candidates; everything else is flexible.
  const driverIdxById = new Map(drivers.map((d, i) => [d.id, i]));
  const routeById = new Map(assignable.map((r) => [r.route.id, r]));
  const kept = (input.existing ?? []).filter((a) => driverIdxById.has(a.driver_id) && routeById.has(a.route_id));
  const keptRouteIds = new Set(kept.map((a) => a.route_id));
  const flexible = buildCandidates(assignable.filter((r) => !keptRouteIds.has(r.route.id)));

  const driverStates = drivers.map((driver) => ({
    driver,
    current_location: driver.home_address,
    available_after: 0,
  }));

  const newAssignments: RouteAssignment[] = [];
  const unassigned: UnassignedRoute[] = [];

  for (const periodType of ["AM", "PM"] as const) {
    // Reset all drivers to home at the start of each period.
    for (const state of driverStates) {
      state.current_location = state.driver.home_address;
      state.available_after = 0;
    }

    // Group existing assignments by (driver, route_code) for merging, same as
    // new candidates that share a code.
    const fixedGroups = new Map<string, { driverIdx: number; routes: RouteWithStudents[] }>();
    for (const a of kept) {
      const r = routeById.get(a.route_id)!;
      if (r.route.type !== periodType) continue;
      const key = `${a.driver_id}_${r.route.route_code || r.route.id}`;
      if (!fixedGroups.has(key)) fixedGroups.set(key, { driverIdx: driverIdxById.get(a.driver_id)!, routes: [] });
      fixedGroups.get(key)!.routes.push(r);
    }

    const allCandidates: SolverCandidate[] = [
      ...[...fixedGroups.values()].map((g) => {
        const parts = g.routes.map(({ route, students }) => ({
          route,
          merged_route_ids: [route.id],
          students,
          start_minutes: timeToMinutes(route.scheduled_start_time),
          end_minutes: timeToMinutes(route.scheduled_end_time),
        }));
        return { candidate: parts.length === 1 ? parts[0] : mergeCandidateGroup(parts), fixed: true, fixedDriverIdx: g.driverIdx };
      }),
      ...flexible
        .filter((c) => c.route.type === periodType)
        .map((c) => ({ candidate: c, fixed: false, fixedDriverIdx: -1 })),
    ];
    if (allCandidates.length === 0) continue;

    // Sort by anchor time (AM: bell/end_minutes, PM: dismissal/start_minutes)
    const anchor = (sc: SolverCandidate) => (periodType === "AM" ? sc.candidate.end_minutes : sc.candidate.start_minutes);
    allCandidates.sort((a, b) => anchor(a) - anchor(b));

    const homes: Waypoint[] = drivers.map((d) => ({ address: d.home_address, lat: d.home_latitude!, lng: d.home_longitude! }));
    const ends: Waypoint[] = allCandidates.map((sc) => {
      const end = getCandidateEndLocation(sc.candidate, periodType);
      return { address: end.address, lat: end.lat, lng: end.lng };
    });
    const homeTrips = await priceTrips(provider, homes, allCandidates, periodType);
    const interRouteTrips = await priceTrips(provider, ends, allCandidates, periodType);

    const solution = solvePeriod(allCandidates, drivers.length, homeTrips, interRouteTrips, periodType, cfg.buffer_minutes, cfg.max_iterations);
    const flexibleInPeriod = allCandidates.filter((sc) => !sc.fixed).length;
    diagnostics.push({
      period: periodType,
      candidates: flexibleInPeriod,
      seed_assigned: solution.seed ? solution.seed.flexibleCount : null,
      seed_miles: solution.seed ? round2(solution.seed.totalMiles) : null,
      assigned: solution.assignedCount,
      miles: round2(solution.totalMiles),
      iterations: solution.iterations,
      timed_out: solution.timedOut,
    });
    if (solution.timedOut) {
      warnings.push(`[${periodType}] Solver hit ${cfg.max_iterations.toLocaleString("en-US")} iteration limit — returning best solution found so far.`);
    }

    // Apply the best solution. Process ALL candidates in order to maintain
    // correct driver state progression, but only emit output for flexible ones.
    for (let ci = 0; ci < allCandidates.length; ci++) {
      const sc = allCandidates[ci];
      const candidate = sc.candidate;
      const placed = solution.assignment.get(ci);

      if (!placed) {
        if (!sc.fixed) {
          for (const routeId of candidate.merged_route_ids) {
            unassigned.push({
              route_id: routeId,
              route_type: candidate.route.type,
              route_code: candidate.route.route_code ?? null,
              school_address: candidate.route.school_address,
              reason: "No driver available — all drivers have time conflicts",
            });
          }
        }
        continue;
      }

      const driverState = driverStates[placed.driverIdx];
      const trip = placed.tripInfo.trip;
      if (!sc.fixed) {
        const n = candidate.merged_route_ids.length;
        for (const routeId of candidate.merged_route_ids) {
          newAssignments.push({
            driver_id: driverState.driver.id,
            driver_name: driverState.driver.name,
            route_id: routeId,
            route_type: candidate.route.type,
            route_code: candidate.route.route_code ?? null,
            school_address: candidate.route.school_address,
            student_addresses: candidate.students.map((s) => s.home_address),
            scheduled_start: candidate.route.scheduled_start_time,
            estimated_travel_minutes: Math.round(trip.totalMinutes / n),
            estimated_miles: Math.round((trip.totalMiles / n) * 100) / 100,
            trip_description: buildTripDescription(driverState.current_location, candidate.students, candidate.route),
            driver_start_location: driverState.current_location,
            driver_end_location: trip.endAddress,
            trip_group_ids: candidate.merged_route_ids,
          });
        }
      }

      // Update driver state for both fixed and flexible
      const after = stateAfterAssignment(candidate, placed.tripInfo, periodType, driverState.available_after, cfg.buffer_minutes);
      driverState.available_after = after.available_after;
      driverState.current_location = after.location;
    }
  }

  if (unassigned.length > 0) {
    warnings.push(`${unassigned.length} route(s) could not be assigned. Consider adding drivers.`);
  }

  const totalMiles = newAssignments.reduce((sum, a) => sum + a.estimated_miles, 0);
  const totalMinutes = newAssignments.reduce((sum, a) => sum + a.estimated_travel_minutes, 0);
  const driversUsed = new Set([...kept.map((a) => a.driver_id), ...newAssignments.map((a) => a.driver_id)]).size;

  return {
    assignments: newAssignments,
    unassigned,
    stats: {
      total_routes: allRoutes.length,
      assigned: kept.length + newAssignments.length,
      unassigned: unassigned.length,
      flagged_skipped: flaggedCount,
      total_estimated_miles: Math.round(totalMiles * 100) / 100,
      total_estimated_minutes: Math.round(totalMinutes),
      drivers_used: driversUsed,
    },
    diagnostics,
    warnings,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyResult(warning: string, routes: Route[]): OptimizationResult {
  return {
    assignments: [],
    unassigned: routes
      .filter((r) => !r.flagged)
      .map((r) => ({
        route_id: r.id,
        route_type: r.type,
        route_code: r.route_code ?? null,
        school_address: r.school_address,
        reason: warning,
      })),
    stats: {
      total_routes: routes.length,
      assigned: 0,
      unassigned: routes.filter((r) => !r.flagged).length,
      flagged_skipped: routes.filter((r) => r.flagged).length,
      total_estimated_miles: 0,
      total_estimated_minutes: 0,
      drivers_used: 0,
    },
    diagnostics: [],
    warnings: [warning],
  };
}
