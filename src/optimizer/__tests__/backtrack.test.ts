import { describe, it, expect } from "vitest";
import { solvePeriod, type SolverCandidate } from "../backtrack";
import type { RouteCandidate, TripInfo } from "../types";
import type { Route } from "../../shared/types";

let routeCounter = 0;
function makeCandidate(endMinutes: number, startMinutes = 0): RouteCandidate {
  routeCounter += 1;
  const route: Route = {
    id: `route-${routeCounter}`,
    school_address: "1 School Rd",
    school_latitude: 40,
    school_longitude: -70,
    type: "AM",
    scheduled_start_time: "07:00",
    scheduled_end_time: "08:00",
    route_code: null,
    flagged: false,
  };
  return { route, merged_route_ids: [route.id], students: [], start_minutes: startMinutes, end_minutes: endMinutes };
}

function tripInfo(totalMinutes: number, totalMiles: number): TripInfo {
  return { trip: { totalMiles, totalMinutes, endLat: 0, endLng: 0, endAddress: "end" } };
}

const flex = (candidate: RouteCandidate): SolverCandidate => ({ candidate, fixed: false, fixedDriverIdx: -1 });

describe("solvePeriod — coverage first", () => {
  it("recovers full coverage where the greedy seed covers less", () => {
    // c0 (bell 50): driver 0 is 2 mi away, driver 1 is 3 mi. Greedy takes driver 0.
    // c1 (bell 60): only reachable by driver 0 from home, and not after c0.
    const ordered = [flex(makeCandidate(50)), flex(makeCandidate(60))];
    const home = [
      [tripInfo(30, 2), tripInfo(40, 4)],
      [tripInfo(35, 3), tripInfo(500, 50)],
    ];
    const inter = [
      [tripInfo(0, 0), tripInfo(30, 3)], // after c0 (avail 40): 40 + 10 + 30 = 80 > 60
      [tripInfo(0, 0), tripInfo(0, 0)],
    ];

    const result = solvePeriod(ordered, 2, home, inter, "AM", 10);
    expect(result.seed).not.toBeNull();
    expect(result.seed!.flexibleCount).toBe(1);
    expect(result.assignedCount).toBe(2);
    expect(result.assignment.get(0)?.driverIdx).toBe(1);
    expect(result.assignment.get(1)?.driverIdx).toBe(0);
  });

  it("never trades coverage for miles", () => {
    // Covering both costs 100 miles; covering one costs 1 mile. Coverage wins.
    const ordered = [flex(makeCandidate(500)), flex(makeCandidate(500))];
    const home = [
      [tripInfo(10, 1), tripInfo(10, 99)],
      [tripInfo(10, 99), tripInfo(10, 99)],
    ];
    const inter = [
      [tripInfo(0, 0), tripInfo(900, 1)], // chaining never feasible
      [tripInfo(900, 1), tripInfo(0, 0)],
    ];
    const result = solvePeriod(ordered, 2, home, inter, "AM", 10);
    expect(result.assignedCount).toBe(2);
    expect(result.totalMiles).toBeCloseTo(100);
  });
});

describe("solvePeriod — tie-breaks", () => {
  it("among equal coverage, picks the lower-mileage assignment", () => {
    // Nearest-first greedy: c0 -> driver 0 (5 mi), c1 -> driver 1 (20 mi) = 25.
    // Optimal: c0 -> driver 1 (6 mi), c1 -> driver 0 (5 mi) = 11.
    const ordered = [flex(makeCandidate(500)), flex(makeCandidate(500))];
    const home = [
      [tripInfo(10, 5), tripInfo(10, 5)],
      [tripInfo(10, 6), tripInfo(10, 20)],
    ];
    const inter = [
      [tripInfo(0, 0), tripInfo(900, 0)],
      [tripInfo(900, 0), tripInfo(0, 0)],
    ];
    const result = solvePeriod(ordered, 2, home, inter, "AM", 10);
    expect(result.seed!.totalMiles).toBe(25);
    expect(result.assignedCount).toBe(2);
    expect(result.totalMiles).toBe(11);
  });

  it("among equal coverage and miles, spreads load across drivers", () => {
    // Driver 0 could chain both at zero extra miles, but that gives max load 2;
    // splitting across drivers at identical miles gives max load 1.
    const ordered = [flex(makeCandidate(100)), flex(makeCandidate(300))];
    const home = [
      [tripInfo(10, 4), tripInfo(10, 4)],
      [tripInfo(10, 4), tripInfo(10, 4)],
    ];
    const inter = [
      [tripInfo(0, 0), tripInfo(10, 4)],
      [tripInfo(0, 0), tripInfo(0, 0)],
    ];
    const result = solvePeriod(ordered, 2, home, inter, "AM", 10);
    expect(result.assignedCount).toBe(2);
    expect(result.maxLoad).toBe(1);
  });
});

describe("solvePeriod — fixed (preserved) candidates", () => {
  it("keeps a fixed candidate on its designated driver and routes around it", () => {
    const ordered: SolverCandidate[] = [
      { candidate: makeCandidate(100), fixed: true, fixedDriverIdx: 0 },
      flex(makeCandidate(110)),
    ];
    const home = [
      [tripInfo(20, 1), tripInfo(20, 1)],
      [tripInfo(20, 7), tripInfo(20, 7)],
    ];
    const inter = [
      [tripInfo(0, 0), tripInfo(80, 1)], // driver 0 can't chain: 30 + 10 + 80 = 120 > 110
      [tripInfo(0, 0), tripInfo(0, 0)],
    ];
    const result = solvePeriod(ordered, 2, home, inter, "AM", 10);
    expect(result.assignment.get(0)?.driverIdx).toBe(0);
    expect(result.assignment.get(1)?.driverIdx).toBe(1);
    expect(result.assignedCount).toBe(1); // fixed candidates don't count toward coverage
    expect(result.totalMiles).toBe(7);    // ...or toward miles
  });

  it("prunes any branch where a new route would make a preserved route late", () => {
    // Driver 0 is nearest for the flexible c0, but taking it would make them
    // late for their preserved c1. The flexible route must go elsewhere.
    const ordered: SolverCandidate[] = [
      flex(makeCandidate(60)),
      { candidate: makeCandidate(80), fixed: true, fixedDriverIdx: 0 },
    ];
    const home = [
      [tripInfo(20, 1), tripInfo(20, 1)],
      [tripInfo(20, 9), tripInfo(20, 9)],
    ];
    const inter = [
      [tripInfo(0, 0), tripInfo(45, 1)], // after c0 (avail 30): 30 + 10 + 45 = 85 > 80
      [tripInfo(0, 0), tripInfo(0, 0)],
    ];
    const result = solvePeriod(ordered, 2, home, inter, "AM", 10);
    expect(result.assignment.get(1)?.driverIdx).toBe(0);
    expect(result.assignment.get(0)?.driverIdx).toBe(1);
  });
});

describe("solvePeriod — iteration cap", () => {
  it("reports a timeout and still returns at least the greedy seed", () => {
    const n = 12;
    const ordered = Array.from({ length: n }, (_, i) => flex(makeCandidate(1000 + i * 30)));
    const home = Array.from({ length: 4 }, (_, d) => ordered.map((_, c) => tripInfo(5, 1 + ((d + c) % 3))));
    const inter = ordered.map(() => ordered.map(() => tripInfo(5, 2)));
    const result = solvePeriod(ordered, 4, home, inter, "AM", 5, 50);
    expect(result.timedOut).toBe(true);
    expect(result.seed).not.toBeNull();
    expect(result.assignedCount).toBeGreaterThanOrEqual(result.seed!.flexibleCount);
    expect(result.assignedCount).toBe(n);
  });

  it("never reports more iterations than the cap", () => {
    const n = 12;
    const ordered = Array.from({ length: n }, (_, i) => flex(makeCandidate(1000 + i * 30)));
    const home = Array.from({ length: 4 }, (_, d) => ordered.map((_, c) => tripInfo(5, 1 + ((d + c) % 3))));
    const inter = ordered.map(() => ordered.map(() => tripInfo(5, 2)));
    for (const cap of [1, 5, 50]) {
      const result = solvePeriod(ordered, 4, home, inter, "AM", 5, cap);
      expect(result.timedOut).toBe(true);
      expect(result.iterations).toBe(cap);
    }
  });
});
