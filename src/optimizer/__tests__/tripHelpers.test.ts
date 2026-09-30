import { describe, it, expect } from "vitest";
import {
  calculateFullTrip,
  buildTripDescription,
  mergeCandidateGroup,
  stateAfterAssignment,
  buildWaypointChain,
} from "../tripHelpers";
import type { RouteCandidate, StudentInfo, TripInfo } from "../types";
import type { Route } from "../../shared/types";

function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    id: "route-1",
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

function makeStudent(overrides: Partial<StudentInfo> = {}): StudentInfo {
  return {
    home_address: "1 Home St",
    home_latitude: 1,
    home_longitude: 2,
    school_address: "1 School Rd",
    school_latitude: 40,
    school_longitude: -70,
    ...overrides,
  };
}

describe("calculateFullTrip", () => {
  it("AM routes always end at the school, with placeholder 0 miles/minutes (Maps API fills these in later)", () => {
    const route = makeRoute({ type: "AM" });
    const students = [makeStudent({ home_address: "2 Home St" })];
    const trip = calculateFullTrip(0, 0, students, route);
    expect(trip).toEqual({
      totalMiles: 0,
      totalMinutes: 0,
      endLat: 40,
      endLng: -70,
      endAddress: "1 School Rd",
    });
  });

  it("PM routes end at the last geocoded student's home", () => {
    const route = makeRoute({ type: "PM" });
    const students = [
      makeStudent({ home_address: "A St", home_latitude: 5, home_longitude: 6 }),
      makeStudent({ home_address: "B St", home_latitude: 7, home_longitude: 8 }),
    ];
    const trip = calculateFullTrip(0, 0, students, route);
    expect(trip).toEqual({
      totalMiles: 0,
      totalMinutes: 0,
      endLat: 7,
      endLng: 8,
      endAddress: "B St",
    });
  });

  it("PM routes with no geocoded students fall back to ending at the school", () => {
    const route = makeRoute({ type: "PM", school_latitude: 11, school_longitude: 12 });
    const students = [makeStudent({ home_latitude: null, home_longitude: null })];
    const trip = calculateFullTrip(0, 0, students, route);
    expect(trip.endLat).toBe(11);
    expect(trip.endLng).toBe(12);
    expect(trip.endAddress).toBe(route.school_address);
  });
});

describe("buildTripDescription", () => {
  it("describes an AM trip as driver -> student homes -> school", () => {
    const route = makeRoute({ type: "AM" });
    const students = [makeStudent({ home_address: "A St" }), makeStudent({ home_address: "B St" })];
    expect(buildTripDescription("Driver Home", students, route)).toBe(
      "Driver Home → A St → B St → 1 School Rd",
    );
  });

  it("describes a PM trip as driver -> school -> student homes", () => {
    const route = makeRoute({ type: "PM" });
    const students = [makeStudent({ home_address: "A St" })];
    expect(buildTripDescription("Driver Home", students, route)).toBe(
      "Driver Home → 1 School Rd → A St",
    );
  });
});

describe("mergeCandidateGroup", () => {
  it("merges route IDs, dedupes students by (home, school), and takes min/max of the time window", () => {
    const routeA = makeRoute({ id: "r-a", route_code: "CODE1" });
    const routeB = makeRoute({ id: "r-b", route_code: "CODE1" });
    const sharedStudent = makeStudent({ home_address: "Shared St" });

    const groupA: RouteCandidate = {
      route: routeA,
      merged_route_ids: ["r-a"],
      students: [sharedStudent],
      start_minutes: 420, // 07:00
      end_minutes: 480, // 08:00
    };
    const groupB: RouteCandidate = {
      route: routeB,
      merged_route_ids: ["r-b"],
      students: [sharedStudent, makeStudent({ home_address: "Other St" })],
      start_minutes: 400, // earlier start
      end_minutes: 500, // later end
    };

    const merged = mergeCandidateGroup([groupA, groupB]);

    expect(merged.merged_route_ids.sort()).toEqual(["r-a", "r-b"]);
    expect(merged.students).toHaveLength(2); // "Shared St" deduped
    expect(merged.students.map((s) => s.home_address).sort()).toEqual(["Other St", "Shared St"]);
    expect(merged.start_minutes).toBe(400);
    expect(merged.end_minutes).toBe(500);
    // Primary is the group with the earliest start_minutes after sorting (groupB, start=400)
    expect(merged.route.id).toBe("r-b");
  });
});

describe("stateAfterAssignment", () => {
  it("AM: available_after accumulates buffer + trip minutes on top of the driver's prior availability", () => {
    const route = makeRoute({ type: "AM" });
    const candidate: RouteCandidate = {
      route,
      merged_route_ids: [route.id],
      students: [],
      start_minutes: 420,
      end_minutes: 480,
    };
    const tripInfo: TripInfo = {
      trip: { totalMiles: 4, totalMinutes: 25, endLat: 1, endLng: 2, endAddress: "End Addr" },
    };
    // currentAvailableAfter=100, buffer=10 -> 100+10+25=135
    const result = stateAfterAssignment(candidate, tripInfo, "AM", 100, 10);
    expect(result).toEqual({ available_after: 135, lat: 1, lng: 2, location: "End Addr" });
  });

  it("PM: available_after is anchored to the route's own start time plus dropoff-only minutes (excludes travel-to-school time)", () => {
    const route = makeRoute({ type: "PM", scheduled_start_time: "15:00" }); // 900
    const candidate: RouteCandidate = {
      route,
      merged_route_ids: [route.id],
      students: [],
      start_minutes: 900,
      end_minutes: 945,
    };
    const tripInfo: TripInfo = {
      trip: { totalMiles: 6, totalMinutes: 30, endLat: 3, endLng: 4, endAddress: "Home Addr" },
      travelToSchoolMinutes: 12,
    };
    // dropoff-only minutes = 30 - 12 = 18; available_after = candidate.start_minutes(900) + 18 = 918
    const result = stateAfterAssignment(candidate, tripInfo, "PM", 500, 10);
    expect(result).toEqual({ available_after: 918, lat: 3, lng: 4, location: "Home Addr" });
  });

  it("PM: dropoff minutes never go negative even if trip total is less than travel-to-school time", () => {
    const route = makeRoute({ type: "PM", scheduled_start_time: "15:00" });
    const candidate: RouteCandidate = {
      route,
      merged_route_ids: [route.id],
      students: [],
      start_minutes: 900,
      end_minutes: 945,
    };
    const tripInfo: TripInfo = {
      trip: { totalMiles: 1, totalMinutes: 5, endLat: 0, endLng: 0, endAddress: "X" },
      travelToSchoolMinutes: 12, // exceeds totalMinutes
    };
    const result = stateAfterAssignment(candidate, tripInfo, "PM", 0, 10);
    expect(result.available_after).toBe(900); // 900 + max(5-12, 0) = 900
  });
});

describe("buildWaypointChain", () => {
  it("AM: driver -> student homes -> school", () => {
    const route = makeRoute({ type: "AM" });
    const students = [makeStudent({ home_address: "A St" }), makeStudent({ home_address: "B St" })];
    const chain = buildWaypointChain("Driver Home", route, null, { totalMiles: 0, totalMinutes: 0, endLat: 0, endLng: 0, endAddress: "" }, students);
    expect(chain).toEqual(["Driver Home", "A St", "B St", "1 School Rd"]);
  });

  it("PM: driver -> school -> student homes", () => {
    const route = makeRoute({ type: "PM" });
    const students = [makeStudent({ home_address: "A St" })];
    const chain = buildWaypointChain("Driver Home", route, null, { totalMiles: 0, totalMinutes: 0, endLat: 0, endLng: 0, endAddress: "" }, students);
    expect(chain).toEqual(["Driver Home", "1 School Rd", "A St"]);
  });

  it("PM with no students: driver -> school only", () => {
    const route = makeRoute({ type: "PM" });
    const chain = buildWaypointChain("Driver Home", route, null, { totalMiles: 0, totalMinutes: 0, endLat: 0, endLng: 0, endAddress: "" }, []);
    expect(chain).toEqual(["Driver Home", "1 School Rd"]);
  });
});
