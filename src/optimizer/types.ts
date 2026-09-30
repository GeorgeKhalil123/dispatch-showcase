import type { Route } from "../shared/types";

// ---------------------------------------------------------------------------
// Public result types (same shape the full optimizer returns)
// ---------------------------------------------------------------------------

export interface SolveConfig {
  buffer_minutes: number;          // Traffic buffer between routes (default 10)
  max_iterations?: number;         // Backtracking cap per period (default 2,000,000)
}

export interface RouteAssignment {
  driver_id: string;
  driver_name: string;
  route_id: string;
  route_type: "AM" | "PM";
  route_code: string | null;
  school_address: string;
  student_addresses: string[];      // Home addresses of students on this route
  scheduled_start: string;
  estimated_travel_minutes: number; // Total trip time
  estimated_miles: number;          // Total trip distance
  trip_description: string;         // Human-readable trip summary
  driver_start_location: string;    // Where driver starts (home or end of previous route)
  driver_end_location: string;      // Where driver ends after this route
  trip_group_ids?: string[];        // All route IDs merged into this same physical trip
}

export interface UnassignedRoute {
  route_id: string;
  route_type: "AM" | "PM";
  route_code: string | null;
  school_address: string;
  reason: string;
}

export interface PeriodDiagnostics {
  period: "AM" | "PM";
  candidates: number;        // flexible candidates the solver tried to place
  seed_assigned: number | null; // greedy seed coverage (null = seed discarded)
  seed_miles: number | null; // greedy seed miles over flexible candidates
  assigned: number;          // final coverage after backtracking
  miles: number;             // final miles over flexible candidates
  iterations: number;
  timed_out: boolean;
}

export interface OptimizationResult {
  assignments: RouteAssignment[];
  unassigned: UnassignedRoute[];
  stats: {
    total_routes: number;
    assigned: number;
    unassigned: number;
    flagged_skipped: number;
    total_estimated_miles: number;
    total_estimated_minutes: number;
    drivers_used: number;
  };
  diagnostics: PeriodDiagnostics[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Internal types for the solver (shared across optimizer/* modules)
// ---------------------------------------------------------------------------

export interface StudentInfo {
  home_address: string;
  home_latitude: number | null;
  home_longitude: number | null;
  school_address: string;
  school_latitude: number | null;
  school_longitude: number | null;
}

export interface RouteCandidate {
  route: Route;
  merged_route_ids: string[];     // All route IDs in this group (for assignment)
  students: StudentInfo[];
  start_minutes: number;          // scheduled start as minutes since midnight
  end_minutes: number;
}

export interface TripInfo {
  trip: {
    totalMiles: number;
    totalMinutes: number;
    endLat: number;
    endLng: number;
    endAddress: string;
  };
  travelToSchoolMinutes?: number;
}
