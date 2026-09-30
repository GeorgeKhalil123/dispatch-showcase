import { describe, it, expect } from "vitest";
import type { Student } from "../../shared/types";
import { groupStudents, refineGroups, UnionFind } from "../groupStudents";
import { MatrixProvider, legKey, type TravelTimeProvider } from "../../optimizer/travelTime";

// Home coordinates ~0.4 mi apart (near), and a third ~14 mi away (far).
// School coordinates mirror the same near/far split.
const NEAR_HOME_A = { lat: 40.0, lng: -75.0 };
const NEAR_HOME_B = { lat: 40.006, lng: -75.0 }; // ~0.4 mi north
const FAR_HOME = { lat: 40.2, lng: -75.0 };      // ~14 mi north

const SCHOOL_A = { lat: 41.0, lng: -76.0 };
const SCHOOL_B = { lat: 41.01, lng: -76.0 };  // ~0.7 mi from SCHOOL_A — "near" school
const SCHOOL_FAR = { lat: 42.0, lng: -76.0 }; // far from SCHOOL_A

function makeStudent(overrides: Partial<Student> = {}): Student {
  return {
    id: "s1",
    name: "Student",
    home_address: "1 Home St",
    home_latitude: NEAR_HOME_A.lat,
    home_longitude: NEAR_HOME_A.lng,
    school_address: "1 School Rd",
    school_latitude: SCHOOL_A.lat,
    school_longitude: SCHOOL_A.lng,
    school_start_time: "08:00",
    school_end_time: "15:00",
    requires_accommodation: false,
    ...overrides,
  };
}

describe("UnionFind", () => {
  it("merges transitively and keeps disjoint sets apart", () => {
    const uf = new UnionFind();
    uf.union("a", "b");
    uf.union("c", "d");
    uf.union("b", "c");
    uf.find("e");
    expect(uf.find("a")).toBe(uf.find("d"));
    expect(uf.find("e")).not.toBe(uf.find("a"));
  });
});

describe("groupStudents", () => {
  it("returns an empty array when there are no students", () => {
    expect(groupStudents([], "both")).toEqual([]);
  });

  it("excludes students missing geocoded coordinates from every group", () => {
    const geocoded = makeStudent({ id: "s1" });
    const ungeocoded = makeStudent({ id: "s2", home_latitude: null, home_longitude: null });
    const allIds = groupStudents([geocoded, ungeocoded], "both").flatMap((g) => g.students.map((s) => s.id));
    expect(allIds).toEqual(["s1"]);
  });

  it("excludes students who require an accommodation", () => {
    const a = makeStudent({ id: "a" });
    const b = makeStudent({ id: "b", requires_accommodation: true });
    const allIds = groupStudents([a, b], "school").flatMap((g) => g.students.map((s) => s.id));
    expect(allIds).toEqual(["a"]);
  });

  it('mode "neighborhood": groups students whose homes are near, even with different schools', () => {
    const a = makeStudent({ id: "a", school_address: "School A" });
    const b = makeStudent({ id: "b", home_latitude: NEAR_HOME_B.lat, home_longitude: NEAR_HOME_B.lng, school_address: "School Z", school_latitude: SCHOOL_FAR.lat, school_longitude: SCHOOL_FAR.lng });
    const groups = groupStudents([a, b], "neighborhood");
    expect(groups).toHaveLength(1);
    expect(groups[0].students.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it('mode "neighborhood": keeps distant homes in separate groups', () => {
    const a = makeStudent({ id: "a" });
    const b = makeStudent({ id: "b", home_latitude: FAR_HOME.lat, home_longitude: FAR_HOME.lng });
    expect(groupStudents([a, b], "neighborhood")).toHaveLength(2);
  });

  it('mode "school": groups students at the same school even when homes are far apart', () => {
    const a = makeStudent({ id: "a", school_address: "Same School" });
    const b = makeStudent({ id: "b", home_latitude: FAR_HOME.lat, home_longitude: FAR_HOME.lng, school_address: "Same School" });
    const groups = groupStudents([a, b], "school");
    expect(groups).toHaveLength(1);
    expect(groups[0].students.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it('mode "both": near homes but far schools stay ungrouped', () => {
    const a = makeStudent({ id: "a", school_address: "School A" });
    const b = makeStudent({
      id: "b",
      home_latitude: NEAR_HOME_B.lat, home_longitude: NEAR_HOME_B.lng,
      school_address: "School Far", school_latitude: SCHOOL_FAR.lat, school_longitude: SCHOOL_FAR.lng,
    });
    expect(groupStudents([a, b], "both")).toHaveLength(2);
  });

  it('mode "both": groups students with near homes AND schools within the prefilter radius', () => {
    const a = makeStudent({ id: "a", school_address: "School A" });
    const b = makeStudent({
      id: "b",
      home_latitude: NEAR_HOME_B.lat, home_longitude: NEAR_HOME_B.lng,
      school_address: "School B", school_latitude: SCHOOL_B.lat, school_longitude: SCHOOL_B.lng,
    });
    expect(groupStudents([a, b], "both")).toHaveLength(1);
  });

  it("computes group centroid as the average of member home coordinates", () => {
    const a = makeStudent({ id: "a", home_latitude: 10, home_longitude: 20, school_address: "Same" });
    const b = makeStudent({ id: "b", home_latitude: 10.001, home_longitude: 20.001, school_address: "Same" });
    const groups = groupStudents([a, b], "school");
    expect(groups).toHaveLength(1);
    expect(groups[0].centroid_lat).toBeCloseTo(10.0005, 4);
    expect(groups[0].centroid_lng).toBeCloseTo(20.0005, 4);
  });

  it("takes the earliest start time and latest end time across all group members", () => {
    const a = makeStudent({ id: "a", school_address: "Same", school_start_time: "08:15", school_end_time: "15:00" });
    const b = makeStudent({
      id: "b", school_address: "Same",
      home_latitude: NEAR_HOME_B.lat, home_longitude: NEAR_HOME_B.lng,
      school_start_time: "07:45", school_end_time: "15:30",
    });
    const groups = groupStudents([a, b], "school");
    expect(groups).toHaveLength(1);
    expect(groups[0].school_start_time).toBe("07:45");
    expect(groups[0].school_end_time).toBe("15:30");
  });

  it("chains transitively: A near B and B near C merges all three even if A and C alone would not qualify", () => {
    // ~1.0 mi steps: A-B and B-C are within 1.5 mi, A-C (~2.1 mi) is not.
    const a = makeStudent({ id: "a", home_latitude: 40.0, home_longitude: -75.0, school_address: "S1", school_latitude: 41.0 });
    const b = makeStudent({ id: "b", home_latitude: 40.015, home_longitude: -75.0, school_address: "S2", school_latitude: 41.0 });
    const c = makeStudent({ id: "c", home_latitude: 40.03, home_longitude: -75.0, school_address: "S3", school_latitude: 41.0 });
    const groups = groupStudents([a, b, c], "neighborhood");
    expect(groups).toHaveLength(1);
    expect(groups[0].students).toHaveLength(3);
  });
});

describe("refineGroups", () => {
  const a = makeStudent({ id: "a", school_address: "School A" });
  const b = makeStudent({ id: "b", home_latitude: NEAR_HOME_B.lat, home_longitude: NEAR_HOME_B.lng, school_address: "School B", school_latitude: SCHOOL_B.lat, school_longitude: SCHOOL_B.lng });

  it("keeps a group whose schools are within 5 minutes by travel time", async () => {
    const provider = new MatrixProvider({ [legKey("School A", "School B")]: { miles: 1, minutes: 4 } });
    const { groups } = await refineGroups(groupStudents([a, b], "both"), provider);
    expect(groups).toHaveLength(1);
  });

  it("splits a haversine group whose schools are actually more than 5 minutes apart", async () => {
    const provider = new MatrixProvider({ [legKey("School A", "School B")]: { miles: 1, minutes: 12 } });
    const { groups } = await refineGroups(groupStudents([a, b], "both"), provider);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.students.length === 1)).toBe(true);
  });

  it("keeps the haversine result and warns when the provider fails", async () => {
    const failing: TravelTimeProvider = { name: "down", estimateLegs: async () => { throw new Error("quota exceeded"); } };
    const { groups, warnings } = await refineGroups(groupStudents([a, b], "both"), failing);
    expect(groups).toHaveLength(1);
    expect(warnings[0]).toContain("quota exceeded");
  });
});
