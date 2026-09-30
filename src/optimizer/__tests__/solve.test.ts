import { describe, it, expect } from "vitest";
import { buildCandidates, solve, type RouteWithStudents } from "../solve";
import { HaversineProvider, MatrixProvider, legKey, type Leg, type LegEstimate, type TravelTimeProvider } from "../travelTime";
import type { Driver, Route } from "../../shared/types";
import type { StudentInfo } from "../types";
import { DEMO_DATE, demoAssignments, demoDrivers, demoRoutes } from "../../demo/dataset";

function makeDriver(id: string, home: string, lat = 0, lng = 0): Driver {
  return { id, name: `Driver ${id}`, home_address: home, home_latitude: lat, home_longitude: lng };
}

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "r1",
    school_address: "School",
    school_latitude: 1,
    school_longitude: 1,
    type: "AM",
    scheduled_start_time: "07:00",
    scheduled_end_time: "08:00",
    route_code: null,
    flagged: false,
    ...overrides,
  };
}

function student(home: string, lat = 2, lng = 2): StudentInfo {
  return { home_address: home, home_latitude: lat, home_longitude: lng, school_address: "School", school_latitude: 1, school_longitude: 1 };
}

const rw = (route: Partial<Route>, students: StudentInfo[] = []): RouteWithStudents => ({ route: makeRoute(route), students });

class CountingProvider implements TravelTimeProvider {
  readonly name = "counting";
  calls = 0;
  legs = 0;
  constructor(private readonly inner: TravelTimeProvider) {}
  async estimateLegs(legs: Leg[]): Promise<LegEstimate[]> {
    this.calls++;
    this.legs += legs.length;
    return this.inner.estimateLegs(legs);
  }
}

describe("buildCandidates", () => {
  it("merges routes sharing a code, period, school and bell into one trip", () => {
    const candidates = buildCandidates([
      rw({ id: "a", route_code: "X1" }, [student("A St")]),
      rw({ id: "b", route_code: "X1" }, [student("B St")]),
      rw({ id: "c", route_code: "X1", scheduled_end_time: "08:30" }, [student("C St")]),
      rw({ id: "d" }, [student("D St")]),
      rw({ id: "e" }, [student("E St")]),
    ]);
    const ids = candidates.map((c) => c.merged_route_ids.sort().join(",")).sort();
    expect(ids).toEqual(["a,b", "c", "d", "e"]);
  });
});

describe("solve", () => {
  it("returns every non-flagged route as unassigned when there are no drivers", async () => {
    const result = await solve({ drivers: [], routes: [rw({ id: "a" }), rw({ id: "b", flagged: true })] }, new HaversineProvider());
    expect(result.stats.unassigned).toBe(1);
    expect(result.stats.flagged_skipped).toBe(1);
    expect(result.warnings).toEqual(["No drivers available"]);
  });

  it("never auto-assigns flagged (special-accommodation) routes", async () => {
    const result = await solve(
      { drivers: [makeDriver("d1", "Home")], routes: [rw({ id: "ok" }, [student("A St")]), rw({ id: "flag", flagged: true }, [student("B St")])] },
      new HaversineProvider(),
    );
    expect(result.assignments.map((a) => a.route_id)).toEqual(["ok"]);
    expect(result.unassigned).toEqual([]);
    expect(result.stats.flagged_skipped).toBe(1);
  });

  it("prices trips through the provider along driver -> pickups -> school", async () => {
    const provider = new MatrixProvider({
      [legKey("Home", "A St")]: { miles: 3, minutes: 6 },
      [legKey("A St", "School")]: { miles: 4, minutes: 9 },
    }, new HaversineProvider()); // fallback prices the unused inter-route legs
    const result = await solve({ drivers: [makeDriver("d1", "Home")], routes: [rw({ id: "a" }, [student("A St")])] }, provider);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({
      driver_id: "d1",
      estimated_miles: 7,
      estimated_travel_minutes: 15,
      trip_description: "Home → A St → School",
      driver_end_location: "School",
    });
  });

  it("reports a route as unassigned when no driver can make the bell", async () => {
    const provider = new MatrixProvider({
      [legKey("Home", "A St")]: { miles: 30, minutes: 50 },
      [legKey("A St", "School")]: { miles: 30, minutes: 50 },
    }, new HaversineProvider());
    // Drivers start the AM period free from midnight, so use a 01:30 bell:
    // 0 + 10 buffer + 100 trip = 110 > 90.
    const result = await solve(
      { drivers: [makeDriver("d1", "Home")], routes: [rw({ id: "a", scheduled_end_time: "01:30" }, [student("A St")])] },
      provider,
    );
    expect(result.assignments).toEqual([]);
    expect(result.unassigned.map((u) => u.route_id)).toEqual(["a"]);
    expect(result.warnings.some((w) => w.includes("could not be assigned"))).toBe(true);
  });

  it("preserves existing assignments and does not re-emit them", async () => {
    const drivers = [makeDriver("d1", "Home 1", 0, 0), makeDriver("d2", "Home 2", 0.5, 0.5)];
    const routes = [rw({ id: "kept" }, [student("A St")]), rw({ id: "new", scheduled_end_time: "08:05" }, [student("B St", 2.1, 2.1)])];
    const result = await solve(
      { drivers, routes, existing: [{ driver_id: "d2", route_id: "kept", date: DEMO_DATE }] },
      new HaversineProvider(),
    );
    expect(result.assignments.map((a) => a.route_id)).toEqual(["new"]);
    expect(result.stats.assigned).toBe(2);
    expect(result.stats.drivers_used).toBeGreaterThanOrEqual(1);
  });

  it("treats an explicitly undefined config field as unset, not as NaN", async () => {
    const result = await solve(
      { drivers: [makeDriver("d1", "Home")], routes: [rw({ id: "a" }, [student("A St")])] },
      new HaversineProvider(),
      { buffer_minutes: undefined, max_iterations: undefined },
    );
    expect(result.assignments).toHaveLength(1);
  });

  it("batches pricing into two provider calls per period", async () => {
    const provider = new CountingProvider(new HaversineProvider());
    await solve({ drivers: demoDrivers, routes: demoRoutes, existing: demoAssignments }, provider);
    expect(provider.calls).toBe(4); // (home + inter-route) x (AM + PM)
  });

  it("covers every assignable demo route, never doing worse than the greedy seed", async () => {
    const result = await solve({ drivers: demoDrivers, routes: demoRoutes, existing: demoAssignments }, new HaversineProvider());
    expect(result.stats.total_routes).toBe(12);
    expect(result.stats.flagged_skipped).toBe(2);
    expect(result.stats.unassigned).toBe(0);
    expect(result.stats.assigned).toBe(10);
    for (const d of result.diagnostics) {
      expect(d.assigned).toBeGreaterThanOrEqual(d.seed_assigned ?? 0);
      if (d.seed_miles !== null && d.assigned === d.seed_assigned) {
        expect(d.miles).toBeLessThanOrEqual(d.seed_miles + 1e-6);
      }
    }
    // Merged RT101 halves ride one physical trip
    const rt101 = result.assignments.filter((a) => a.route_id.startsWith("rt-101") && a.route_type === "AM");
    expect(new Set(rt101.map((a) => a.driver_id)).size).toBe(1);
    expect(rt101[0].trip_group_ids).toHaveLength(2);
  });
});

describe("travel-time providers", () => {
  const a = { address: "A", lat: 0, lng: 0 };
  const b = { address: "B", lat: 1, lng: 0 };

  it("HaversineProvider converts straight-line miles to minutes at the configured speed", async () => {
    const [est] = await new HaversineProvider(60).estimateLegs([{ from: a, to: b }]);
    expect(est.miles).toBeCloseTo(69.1, 0);
    expect(est.minutes).toBeCloseTo(est.miles, 6); // 60 mph -> 1 mile per minute
  });

  it("MatrixProvider throws on an unknown leg instead of guessing", async () => {
    await expect(new MatrixProvider({}).estimateLegs([{ from: a, to: b }])).rejects.toThrow(/no estimate for leg A\|B/);
  });

  it("MatrixProvider prices self-legs as free and defers misses to a fallback", async () => {
    const provider = new MatrixProvider({}, new HaversineProvider(60));
    const [self, miss] = await provider.estimateLegs([{ from: a, to: a }, { from: a, to: b }]);
    expect(self).toEqual({ miles: 0, minutes: 0 });
    expect(miss.miles).toBeCloseTo(69.1, 0);
  });
});
