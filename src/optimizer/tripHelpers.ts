import type { Driver, Route } from "../shared/types";
import type { RouteCandidate, StudentInfo, TripInfo } from "./types";

// ---------------------------------------------------------------------------
// Shared trip-info helpers (used by solve() and the greedy seed)
// ---------------------------------------------------------------------------

/**
 * Determine end location for a route. Miles and minutes are placeholders (0)
 * filled in by the TravelTimeProvider batch before the backtracking solver runs.
 *
 * AM route ends at school. PM route ends at last student's home.
 */
export function calculateFullTrip(
  _driverLat: number, _driverLng: number,
  students: StudentInfo[],
  route: Route,
): { totalMiles: number; totalMinutes: number; endLat: number; endLng: number; endAddress: string } {
  const geocodedStudents = students.filter(
    (s) => s.home_latitude !== null && s.home_longitude !== null,
  );
  const schoolLat = route.school_latitude ?? 0;
  const schoolLng = route.school_longitude ?? 0;

  if (route.type === "AM" || geocodedStudents.length === 0) {
    return { totalMiles: 0, totalMinutes: 0, endLat: schoolLat, endLng: schoolLng, endAddress: route.school_address };
  }

  // PM: ends at last student's home
  const lastStudent = geocodedStudents[geocodedStudents.length - 1];
  return {
    totalMiles: 0,
    totalMinutes: 0,
    endLat: lastStudent.home_latitude!,
    endLng: lastStudent.home_longitude!,
    endAddress: lastStudent.home_address,
  };
}

/**
 * Build a human-readable trip description.
 */
export function buildTripDescription(
  driverStartLocation: string,
  students: StudentInfo[],
  route: Route,
): string {
  const studentHomes = students.map((s) => s.home_address).filter(Boolean);
  const pickupStr = studentHomes.length > 0 ? studentHomes.join(" → ") : "(no student addresses)";

  if (route.type === "AM") {
    return `${driverStartLocation} → ${pickupStr} → ${route.school_address}`;
  } else {
    return `${driverStartLocation} → ${route.school_address} → ${pickupStr}`;
  }
}

/**
 * Merge multiple route candidates into one (for routes going to the same school).
 */
export function mergeCandidateGroup(group: RouteCandidate[]): RouteCandidate {
  group.sort((a, b) => a.start_minutes - b.start_minutes);
  const primary = group[0];
  const allStudents: StudentInfo[] = [];
  const seenAddresses = new Set<string>();
  const allRouteIds: string[] = [];

  for (const rc of group) {
    allRouteIds.push(...rc.merged_route_ids);
    for (const s of rc.students) {
      const key = `${s.home_address}_${s.school_address}`;
      if (!seenAddresses.has(key)) {
        seenAddresses.add(key);
        allStudents.push(s);
      }
    }
  }

  return {
    route: primary.route,
    merged_route_ids: allRouteIds,
    students: allStudents,
    start_minutes: Math.min(...group.map((g) => g.start_minutes)),
    end_minutes: Math.max(...group.map((g) => g.end_minutes)),
  };
}

// Returns a zero-initialized TripInfo placeholder; the provider batch fills in real values.
export function computeTripInfo(
  driverLat: number, driverLng: number, _driverLocation: string,
  candidate: RouteCandidate, periodType: "AM" | "PM",
): TripInfo {
  const trip = calculateFullTrip(driverLat, driverLng, candidate.students, candidate.route);
  return { trip, travelToSchoolMinutes: periodType === "PM" ? 0 : undefined };
}

// Returns the deterministic end location of a completed route.
export function getCandidateEndLocation(candidate: RouteCandidate, pt: "AM" | "PM"): { lat: number; lng: number; address: string } {
  if (pt === "AM") {
    return { lat: candidate.route.school_latitude ?? 0, lng: candidate.route.school_longitude ?? 0, address: candidate.route.school_address };
  }
  const lastStudent = candidate.students[candidate.students.length - 1];
  if (lastStudent) {
    return { lat: lastStudent.home_latitude ?? 0, lng: lastStudent.home_longitude ?? 0, address: lastStudent.home_address };
  }
  return { lat: candidate.route.school_latitude ?? 0, lng: candidate.route.school_longitude ?? 0, address: candidate.route.school_address };
}

// Returns the driver state after completing a candidate route.
// For AM: driver finishes when they arrive at school (actual arrival), not at the bell.
// Using the bell time was overly conservative and caused feasible chaining opportunities to be missed.
export function stateAfterAssignment(
  candidate: RouteCandidate, tripInfo: TripInfo, periodType: "AM" | "PM",
  currentAvailableAfter: number = 0, bufferMinutes: number = 0,
): { available_after: number; lat: number; lng: number; location: string } {
  if (periodType === "AM") {
    const actualArrival = currentAvailableAfter + bufferMinutes + tripInfo.trip.totalMinutes;
    return { available_after: actualArrival, lat: tripInfo.trip.endLat, lng: tripInfo.trip.endLng, location: tripInfo.trip.endAddress };
  }
  const toSchoolMinutes = tripInfo.travelToSchoolMinutes ?? 0;
  const routeExecutionMinutes = Math.max(tripInfo.trip.totalMinutes - toSchoolMinutes, 0);
  return { available_after: candidate.start_minutes + routeExecutionMinutes, lat: tripInfo.trip.endLat, lng: tripInfo.trip.endLng, location: tripInfo.trip.endAddress };
}

// ---------------------------------------------------------------------------
// Waypoint chain construction (the address sequence a trip is priced along)
// ---------------------------------------------------------------------------

export function buildWaypointChain(
  driverLocation: string,
  route: Route,
  _driver: Driver | null,
  _trip: ReturnType<typeof calculateFullTrip>,
  students: StudentInfo[] = [],
): string[] {
  const studentHomes = students
    .filter((s) => s.home_address)
    .map((s) => s.home_address);

  if (route.type === "AM") {
    // driver → student home(s) → school
    return [driverLocation, ...studentHomes, route.school_address];
  } else {
    // driver location → school → student home(s)
    if (studentHomes.length > 0) {
      return [driverLocation, route.school_address, ...studentHomes];
    }
    return [driverLocation, route.school_address];
  }
}
