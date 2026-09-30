import { describe, it, expect } from "vitest";
import { timeToMinutes, isFeasible } from "../feasibility";
import type { RouteCandidate, TripInfo } from "../types";
import type { Route } from "../../shared/types";

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "route-1",
    school_address: "1 School Rd",
    school_latitude: 10,
    school_longitude: 20,
    type: "AM",
    scheduled_start_time: "07:00",
    scheduled_end_time: "08:00",
    route_code: null,
    flagged: false,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  const route = overrides.route ?? makeRoute();
  return {
    route,
    merged_route_ids: [route.id],
    students: overrides.students ?? [],
    start_minutes: timeToMinutes(route.scheduled_start_time),
    end_minutes: timeToMinutes(route.scheduled_end_time),
    ...overrides,
  };
}

function makeTripInfo(totalMinutes: number, travelToSchoolMinutes?: number): TripInfo {
  return {
    trip: { totalMiles: 1, totalMinutes, endLat: 0, endLng: 0, endAddress: "end" },
    travelToSchoolMinutes,
  };
}

describe("timeToMinutes", () => {
  it("converts HH:MM to minutes since midnight", () => {
    expect(timeToMinutes("00:00")).toBe(0);
    expect(timeToMinutes("08:05")).toBe(485);
    expect(timeToMinutes("23:59")).toBe(1439);
    expect(timeToMinutes("12:30")).toBe(750);
  });

  it("returns 0 for null/undefined/empty input", () => {
    expect(timeToMinutes(null)).toBe(0);
    expect(timeToMinutes(undefined)).toBe(0);
    expect(timeToMinutes("")).toBe(0);
  });

  it("falls back to 0 (not NaN) for a malformed non-numeric time string", () => {
    // parseInt("ab", 10) -> NaN for both hour and minute components
    expect(timeToMinutes("ab:cd")).toBe(0);
  });

  it("falls back to 0 for the malformed component only, keeping the well-formed one", () => {
    // hour parses fine, minute does not
    expect(timeToMinutes("08:xy")).toBe(480);
    // minute parses fine, hour does not
    expect(timeToMinutes("xy:30")).toBe(30);
  });

  it("treats a string with no ':' as hour-only, minutes defaulting to 0", () => {
    expect(timeToMinutes("0800")).toBe(800 * 60);
  });
});

describe("isFeasible — AM period", () => {
  it("is feasible when arrival exactly meets the deadline (buffer + trip time honored)", () => {
    const route = makeRoute({ scheduled_end_time: "08:00" }); // 480
    const candidate = makeCandidate({ route });
    const tripInfo = makeTripInfo(20); // 20 minute trip
    // available_after=450, buffer=10 -> departure=460; +20 = 480 == deadline (480) -> feasible
    expect(isFeasible(450, tripInfo, candidate, "AM", 10)).toBe(true);
  });

  it("is infeasible when arrival is one minute past the deadline", () => {
    const route = makeRoute({ scheduled_end_time: "08:00" }); // 480
    const candidate = makeCandidate({ route });
    const tripInfo = makeTripInfo(20);
    // available_after=451 -> departure=461; +20=481 > 480 -> infeasible
    expect(isFeasible(451, tripInfo, candidate, "AM", 10)).toBe(false);
  });

  it("rejects overlapping routes caused by an insufficient buffer between two back-to-back routes", () => {
    const route = makeRoute({ scheduled_end_time: "07:30" }); // 450
    const candidate = makeCandidate({ route });
    const tripInfo = makeTripInfo(15);
    // Driver only just became available (available_after=440); required buffer pushes it over.
    expect(isFeasible(440, tripInfo, candidate, "AM", 10)).toBe(false);
  });
});

describe("isFeasible — PM period", () => {
  it("requires both a timely school arrival AND an on-time dropoff finish", () => {
    const route = makeRoute({ type: "PM", scheduled_start_time: "15:00", scheduled_end_time: "15:45" }); // 900 / 945
    const candidate = makeCandidate({ route });
    // Total trip 30 min, 10 of which is getting to the school (pickup), 20 for dropoff loop after.
    const tripInfo = makeTripInfo(30, 10);
    // available_after=880, buffer=10 -> departure=890; +travelToSchool(10)=900 <= 900 (dismissal) OK
    // dropoffMinutes = 30-10=20; routeAnchor(900)+20=920 <= 945 (end) OK
    expect(isFeasible(880, tripInfo, candidate, "PM", 10)).toBe(true);
  });

  it("is infeasible when the driver arrives at school after dismissal", () => {
    const route = makeRoute({ type: "PM", scheduled_start_time: "15:00", scheduled_end_time: "15:45" });
    const candidate = makeCandidate({ route });
    const tripInfo = makeTripInfo(30, 10);
    // available_after=900 -> departure=910; +10=920 > 900 (dismissal) -> infeasible
    expect(isFeasible(900, tripInfo, candidate, "PM", 10)).toBe(false);
  });

  it("is infeasible when the dropoff loop would finish after the route's end time (overlapping routes)", () => {
    const route = makeRoute({ type: "PM", scheduled_start_time: "15:00", scheduled_end_time: "15:10" }); // 900 / 910
    const candidate = makeCandidate({ route });
    // Arrives at school on time, but the dropoff loop itself (20 min) overruns the route's end window.
    const tripInfo = makeTripInfo(30, 10);
    // departure=880+10=890; +10=900<=900 OK (school arrival)
    // dropoffMinutes=20; routeAnchor(900)+20=920 > 910 (end) -> infeasible
    expect(isFeasible(880, tripInfo, candidate, "PM", 10)).toBe(false);
  });
});
