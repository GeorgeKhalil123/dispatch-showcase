import { describe, it, expect } from "vitest";
import { computeGreedySeed, type GreedySeedCandidate } from "../greedySeed";
import type { RouteCandidate, TripInfo } from "../types";
import type { Route } from "../../shared/types";

let routeCounter = 0;
function makeRoute(overrides: Partial<Route> = {}): Route {
  routeCounter += 1;
  return {
    id: `route-${routeCounter}`,
    school_address: "1 School Rd",
    school_latitude: 40,
    school_longitude: -70,
    type: "AM",
    scheduled_start_time: "07:00",
    scheduled_end_time: "08:00",
    route_code: null,
    flagged: false,
    ...overrides,
  };
}

function makeCandidate(endMinutes: number, startMinutes = 0): RouteCandidate {
  const route = makeRoute({ scheduled_end_time: "08:00" });
  return {
    route,
    merged_route_ids: [route.id],
    students: [],
    start_minutes: startMinutes,
    end_minutes: endMinutes,
  };
}

function tripInfo(totalMinutes: number, totalMiles: number): TripInfo {
  return { trip: { totalMiles, totalMinutes, endLat: 0, endLng: 0, endAddress: "end" } };
}

describe("computeGreedySeed — large synthetic input", () => {
  it("returns a full-coverage seed (not null/partial) for ~180 routes with ample driver capacity", () => {
    const NUM_CANDIDATES = 180;
    const NUM_DRIVERS = 15;
    const TRIP_MINUTES = 5;
    const BUFFER_MINUTES = 8;

    // Deadlines spread generously apart (20 min steps) so that even a single
    // driver's cumulative (buffer+trip=13 min per stop) usage never catches up
    // to the growing deadline — every candidate is feasible for every driver.
    const candidates: GreedySeedCandidate[] = Array.from({ length: NUM_CANDIDATES }, (_, i) => ({
      candidate: makeCandidate(100 + i * 20),
      fixed: false,
      fixedDriverIdx: -1,
    }));

    // Every driver×candidate trip has the same (constant) miles/minutes — only
    // feasibility (time), not distance, determines whether coverage is achieved.
    const homeTrips: TripInfo[][] = Array.from({ length: NUM_DRIVERS }, () =>
      candidates.map(() => tripInfo(TRIP_MINUTES, 1)),
    );
    const interRouteTrips: TripInfo[][] = Array.from({ length: NUM_CANDIDATES }, () =>
      candidates.map(() => tripInfo(TRIP_MINUTES, 1)),
    );

    const result = computeGreedySeed(candidates, NUM_DRIVERS, homeTrips, interRouteTrips, "AM", BUFFER_MINUTES);

    expect(result).not.toBeNull();
    expect(result!.flexibleCount).toBe(NUM_CANDIDATES);
    expect(result!.assignment.size).toBe(NUM_CANDIDATES);
  });
});

describe("computeGreedySeed — fixed/preserved candidate invariant", () => {
  it("assigns a fixed candidate to its designated driver when feasible", () => {
    const fixedCandidate = makeCandidate(480); // 08:00 deadline
    const flexCandidate = makeCandidate(480);
    const allCandidates: GreedySeedCandidate[] = [
      { candidate: fixedCandidate, fixed: true, fixedDriverIdx: 1 },
      { candidate: flexCandidate, fixed: false, fixedDriverIdx: -1 },
    ];
    const homeTrips: TripInfo[][] = [
      [tripInfo(5, 10), tripInfo(5, 10)],
      [tripInfo(5, 1), tripInfo(5, 1)],
    ];
    const interRouteTrips: TripInfo[][] = [
      [tripInfo(5, 1), tripInfo(5, 1)],
      [tripInfo(5, 1), tripInfo(5, 1)],
    ];

    const result = computeGreedySeed(allCandidates, 2, homeTrips, interRouteTrips, "AM", 10);

    expect(result).not.toBeNull();
    // Fixed candidate (index 0) MUST be on driver 1, exactly as designated.
    expect(result!.assignment.get(0)?.driverIdx).toBe(1);
  });

  it("returns null (never violates the preserve invariant) when a fixed candidate cannot be feasibly honored", () => {
    // Deadline is far too tight for the fixed candidate's designated driver to make it.
    const fixedCandidate = makeCandidate(5); // deadline 5 minutes
    const allCandidates: GreedySeedCandidate[] = [
      { candidate: fixedCandidate, fixed: true, fixedDriverIdx: 0 },
    ];
    // Trip takes 100 minutes — utterly infeasible against a 5-minute deadline.
    const homeTrips: TripInfo[][] = [[tripInfo(100, 1)]];
    const interRouteTrips: TripInfo[][] = [[tripInfo(100, 1)]];

    const result = computeGreedySeed(allCandidates, 1, homeTrips, interRouteTrips, "AM", 10);

    expect(result).toBeNull();
  });

  it("leaves a flexible candidate unassigned in the seed when no driver is feasible, without ever dropping a fixed one", () => {
    const fixedCandidate = makeCandidate(480);
    // Flexible candidate's deadline is impossible for every driver.
    const impossibleFlex = makeCandidate(1);
    const allCandidates: GreedySeedCandidate[] = [
      { candidate: fixedCandidate, fixed: true, fixedDriverIdx: 0 },
      { candidate: impossibleFlex, fixed: false, fixedDriverIdx: -1 },
    ];
    const homeTrips: TripInfo[][] = [[tripInfo(5, 1), tripInfo(100, 1)]];
    const interRouteTrips: TripInfo[][] = [
      [tripInfo(5, 1), tripInfo(100, 1)],
      [tripInfo(5, 1), tripInfo(5, 1)],
    ];

    const result = computeGreedySeed(allCandidates, 1, homeTrips, interRouteTrips, "AM", 10);

    expect(result).not.toBeNull();
    expect(result!.assignment.has(0)).toBe(true); // fixed candidate always present
    expect(result!.assignment.has(1)).toBe(false); // impossible flexible candidate skipped
    expect(result!.flexibleCount).toBe(0);
  });
});
