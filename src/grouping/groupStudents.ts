import { haversineDistanceMiles } from "../shared/geo";
import { timeToMinutes } from "../optimizer/feasibility";
import type { TravelTimeProvider, Waypoint } from "../optimizer/travelTime";
import type { Student } from "../shared/types";

// ---------------------------------------------------------------------------
// Carpool grouping. In the full system this reads students from PostgreSQL and
// validates school proximity against Google Maps; here both are injected so
// the algorithm runs on plain data.
// ---------------------------------------------------------------------------

export type GroupingMode = "school" | "neighborhood" | "both";

export interface StudentGroup {
  id: string;                  // Generated group identifier
  students: Student[];
  school_address: string;      // Common (or closest) school
  centroid_lat: number;        // Average home lat
  centroid_lng: number;        // Average home lng
  school_start_time: string;   // Earliest start time in group
  school_end_time: string;     // Latest end time in group
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCHOOL_PROXIMITY_MINUTES = 5;    // Schools within 5 min of each other
export const NEIGHBORHOOD_RADIUS_MILES = 1.5; // Homes within ~1.5 miles
// Generous haversine pre-filter before the travel-time validation call.
// Intentionally larger than the actual driving threshold to avoid false negatives.
export const SCHOOL_PROXIMITY_PREFILTER_MILES = 2.5; // ~5 min at 30 mph

// ---------------------------------------------------------------------------
// Union-Find (path compression + union by rank)
// ---------------------------------------------------------------------------

export class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly rank = new Map<string, number>();

  find(id: string): string {
    if (!this.parent.has(id)) { this.parent.set(id, id); this.rank.set(id, 0); }
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression
    let cur = id;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Grouping logic
// ---------------------------------------------------------------------------

/**
 * Groups students based on the selected mode.
 * - "school": group students going to the same school (or schools within 5 min)
 * - "neighborhood": group students whose homes are nearby
 * - "both": intersection — homes nearby AND schools within 5 min
 *
 * Students needing accommodation or missing coordinates are never grouped.
 * Grouping is transitive: A~B and B~C puts A, B and C in one group.
 */
export function groupStudents(students: Student[], mode: GroupingMode): StudentGroup[] {
  const geocoded = students
    .filter((s) => !s.requires_accommodation)
    .filter(
      (s) => s.home_latitude !== null && s.home_longitude !== null &&
             s.school_latitude !== null && s.school_longitude !== null,
    )
    .sort((a, b) => a.name.localeCompare(b.name));

  if (geocoded.length === 0) return [];

  const uf = new UnionFind();
  for (const s of geocoded) uf.find(s.id);
  for (const [a, b] of buildAdjacency(geocoded, mode)) uf.union(a, b);

  // Collect groups
  const groupMap = new Map<string, Student[]>();
  for (const s of geocoded) {
    const root = uf.find(s.id);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(s);
  }

  const groups: StudentGroup[] = [];
  let idx = 0;
  for (const [, members] of groupMap) {
    idx++;
    groups.push(summarizeGroup(`group-${idx}`, members));
  }
  return groups;
}

function summarizeGroup(id: string, members: Student[]): StudentGroup {
  const centroid_lat = members.reduce((sum, s) => sum + s.home_latitude!, 0) / members.length;
  const centroid_lng = members.reduce((sum, s) => sum + s.home_longitude!, 0) / members.length;

  // Use the most common school address, or the first one
  const schoolCounts = new Map<string, number>();
  for (const m of members) {
    schoolCounts.set(m.school_address, (schoolCounts.get(m.school_address) || 0) + 1);
  }
  let school_address = members[0].school_address;
  let maxCount = 0;
  for (const [addr, count] of schoolCounts) {
    if (count > maxCount) {
      maxCount = count;
      school_address = addr;
    }
  }

  // Bell-time window — earliest start (min minutes), latest end (max minutes).
  // Keep the original string that produced the min/max rather than reformatting.
  const minStart = Math.min(...members.map((m) => timeToMinutes(m.school_start_time)));
  const maxEnd = Math.max(...members.map((m) => timeToMinutes(m.school_end_time)));
  const school_start_time = members.find((m) => timeToMinutes(m.school_start_time) === minStart)!.school_start_time;
  const school_end_time = members.find((m) => timeToMinutes(m.school_end_time) === maxEnd)!.school_end_time;

  return { id, students: members, school_address, centroid_lat, centroid_lng, school_start_time, school_end_time };
}

// ---------------------------------------------------------------------------
// Adjacency builders
// ---------------------------------------------------------------------------

export function buildAdjacency(students: Student[], mode: GroupingMode): Array<[string, string]> {
  const edges: Array<[string, string]> = [];

  for (let i = 0; i < students.length; i++) {
    for (let j = i + 1; j < students.length; j++) {
      const a = students[i];
      const b = students[j];

      const homesNear = areHomesNear(a, b);
      const schoolsNear = areSchoolsNear(a, b);

      if (mode === "school" && schoolsNear) {
        edges.push([a.id, b.id]);
      } else if (mode === "neighborhood" && homesNear) {
        edges.push([a.id, b.id]);
      } else if (mode === "both" && homesNear && schoolsNear) {
        edges.push([a.id, b.id]);
      }
    }
  }

  return edges;
}

export function areHomesNear(a: Student, b: Student): boolean {
  if (a.home_latitude == null || a.home_longitude == null ||
      b.home_latitude == null || b.home_longitude == null) {
    return false;
  }
  const dist = haversineDistanceMiles(a.home_latitude, a.home_longitude, b.home_latitude, b.home_longitude);
  return dist <= NEIGHBORHOOD_RADIUS_MILES;
}

export function areSchoolsNear(a: Student, b: Student): boolean {
  // Same school address — definitely near
  if (a.school_address === b.school_address) return true;

  if (a.school_latitude == null || a.school_longitude == null ||
      b.school_latitude == null || b.school_longitude == null) {
    return false;
  }
  const dist = haversineDistanceMiles(a.school_latitude, a.school_longitude, b.school_latitude, b.school_longitude);
  return dist <= SCHOOL_PROXIMITY_PREFILTER_MILES;
}

/**
 * Refine haversine groups with real travel times between schools. Returns
 * only groups whose schools are truly within SCHOOL_PROXIMITY_MINUTES of each
 * other; any group that fails is split back into single-student groups. If the
 * provider errors, the haversine result is kept rather than failing the run.
 */
export async function refineGroups(
  groups: StudentGroup[],
  provider: TravelTimeProvider,
): Promise<{ groups: StudentGroup[]; warnings: string[] }> {
  const refined: StudentGroup[] = [];
  const warnings: string[] = [];

  for (const group of groups) {
    const schools = new Map<string, Waypoint>();
    for (const s of group.students) {
      if (!schools.has(s.school_address)) {
        schools.set(s.school_address, { address: s.school_address, lat: s.school_latitude!, lng: s.school_longitude! });
      }
    }
    // One student, or all same school — always valid
    if (group.students.length <= 1 || schools.size <= 1) {
      refined.push(group);
      continue;
    }

    const unique = [...schools.values()];
    const legs = unique.flatMap((from, i) => unique.slice(i + 1).map((to) => ({ from, to })));
    try {
      const estimates = await provider.estimateLegs(legs);
      if (estimates.every((e) => e.minutes <= SCHOOL_PROXIMITY_MINUTES)) {
        refined.push(group);
      } else {
        for (const s of group.students) refined.push(summarizeGroup(`${group.id}-${s.id}`, [s]));
      }
    } catch (err) {
      warnings.push(`Travel-time lookup failed for ${group.id}, keeping haversine result: ${(err as Error).message}`);
      refined.push(group);
    }
  }

  return { groups: refined, warnings };
}
