import type { Assignment, Driver, Route, Student } from "../shared/types";
import type { RouteWithStudents } from "../optimizer/solve";
import type { StudentInfo } from "../optimizer/types";
import type { FieldPassRow } from "../ingest/extractor";

// ---------------------------------------------------------------------------
// SYNTHETIC DATA. Every name, address, school and coordinate below is made
// up for this demo: a fictional town ("Fairview") laid out on a small grid.
// 6 drivers, 12 routes (6 AM + 6 PM), 3 schools.
// ---------------------------------------------------------------------------

export const DEMO_DATE = "2026-09-08";

// Grid origin; 0.01 deg lat is ~0.69 mi.
const LAT0 = 41.5;
const LNG0 = -90.5;
const at = (dLat: number, dLng: number) => ({ lat: LAT0 + dLat, lng: LNG0 + dLng });

const SCHOOLS = {
  elementary: { address: "100 School Ln, Fairview", ...at(0.0, 0.0) },
  middle: { address: "200 Campus Dr, Fairview", ...at(0.03, 0.05) },
  high: { address: "300 College Ave, Fairview", ...at(-0.04, 0.06) },
} as const;

export const demoDrivers: Driver[] = [
  { id: "drv-1", name: "Driver 1", home_address: "11 Birch St, Fairview", home_latitude: at(-0.079, -0.026).lat, home_longitude: at(-0.079, -0.026).lng },
  { id: "drv-2", name: "Driver 2", home_address: "22 Cedar St, Fairview", home_latitude: at(-0.041, 0.022).lat, home_longitude: at(-0.041, 0.022).lng },
  { id: "drv-3", name: "Driver 3", home_address: "33 Elm St, Fairview", home_latitude: at(-0.084, 0.054).lat, home_longitude: at(-0.084, 0.054).lng },
  { id: "drv-4", name: "Driver 4", home_address: "44 Fir St, Fairview", home_latitude: at(-0.041, 0.099).lat, home_longitude: at(-0.041, 0.099).lng },
  { id: "drv-5", name: "Driver 5", home_address: "55 Hemlock St, Fairview", home_latitude: at(-0.056, 0.018).lat, home_longitude: at(-0.056, 0.018).lng },
  { id: "drv-6", name: "Driver 6", home_address: "66 Juniper St, Fairview", home_latitude: at(0.028, 0.053).lat, home_longitude: at(0.028, 0.053).lng },
];

type SchoolKey = keyof typeof SCHOOLS;

interface StudentSeed {
  id: string;
  home: string;
  dLat: number;
  dLng: number;
  school: SchoolKey;
  start: string;
  end: string;
  accommodation?: boolean;
}

const STUDENT_SEEDS: StudentSeed[] = [
  { id: "stu-01", home: "1 Oak Ct, Fairview", dLat: 0.012, dLng: -0.010, school: "elementary", start: "07:50", end: "14:30" },
  { id: "stu-02", home: "3 Oak Ct, Fairview", dLat: 0.014, dLng: -0.008, school: "elementary", start: "07:50", end: "14:30" },
  { id: "stu-03", home: "7 Pine Rd, Fairview", dLat: -0.020, dLng: 0.020, school: "elementary", start: "07:50", end: "14:30" },
  { id: "stu-04", home: "9 Aspen Way, Fairview", dLat: 0.045, dLng: 0.030, school: "middle", start: "08:20", end: "15:00" },
  { id: "stu-05", home: "12 Willow Pl, Fairview", dLat: 0.020, dLng: 0.070, school: "middle", start: "08:20", end: "15:00" },
  { id: "stu-06", home: "15 Spruce Ln, Fairview", dLat: -0.050, dLng: 0.040, school: "high", start: "07:30", end: "14:15" },
  { id: "stu-07", home: "18 Maple Ave, Fairview", dLat: -0.030, dLng: 0.090, school: "high", start: "07:30", end: "14:15" },
  { id: "stu-08", home: "21 Poplar Dr, Fairview", dLat: 0.060, dLng: -0.030, school: "middle", start: "08:20", end: "15:00", accommodation: true },
];

function studentName(id: string): string {
  return `Student ${id.slice(-2)}`;
}

export const demoStudents: Student[] = STUDENT_SEEDS.map((s) => ({
  id: s.id,
  name: studentName(s.id),
  home_address: s.home,
  home_latitude: LAT0 + s.dLat,
  home_longitude: LNG0 + s.dLng,
  school_address: SCHOOLS[s.school].address,
  school_latitude: SCHOOLS[s.school].lat,
  school_longitude: SCHOOLS[s.school].lng,
  school_start_time: s.start,
  school_end_time: s.end,
  requires_accommodation: s.accommodation ?? false,
}));

function info(studentId: string): StudentInfo {
  const s = demoStudents.find((x) => x.id === studentId)!;
  return {
    home_address: s.home_address,
    home_latitude: s.home_latitude,
    home_longitude: s.home_longitude,
    school_address: s.school_address,
    school_latitude: s.school_latitude,
    school_longitude: s.school_longitude,
  };
}

function route(
  id: string, type: "AM" | "PM", school: SchoolKey, start: string, end: string,
  studentIds: string[], extra: Partial<Route> = {},
): RouteWithStudents {
  return {
    route: {
      id,
      type,
      school_address: SCHOOLS[school].address,
      school_latitude: SCHOOLS[school].lat,
      school_longitude: SCHOOLS[school].lng,
      scheduled_start_time: start,
      scheduled_end_time: end,
      route_code: null,
      flagged: false,
      ...extra,
    },
    students: studentIds.map(info),
  };
}

// AM: start = earliest pickup, end = bell (drop-off deadline).
// PM: start = dismissal (pickup), end = latest drop-off.
// RT101-A/B share a route code, school and bell, so the solver merges them
// into one trip. RT108 carries a student who needs an accommodation, so both
// halves are flagged and excluded from auto-assignment.
export const demoRoutes: RouteWithStudents[] = [
  route("rt-101a-am", "AM", "elementary", "07:20", "07:50", ["stu-01"], { route_code: "RT101" }),
  route("rt-101b-am", "AM", "elementary", "07:20", "07:50", ["stu-02"], { route_code: "RT101" }),
  route("rt-103-am", "AM", "elementary", "07:15", "07:50", ["stu-03"]),
  route("rt-104-am", "AM", "middle", "07:50", "08:20", ["stu-04", "stu-05"]),
  route("rt-106-am", "AM", "high", "07:00", "07:30", ["stu-06", "stu-07"]),
  route("rt-108-am", "AM", "middle", "07:45", "08:20", ["stu-08"], { flagged: true }),
  route("rt-101a-pm", "PM", "elementary", "14:30", "15:05", ["stu-01"], { route_code: "RT101" }),
  route("rt-101b-pm", "PM", "elementary", "14:30", "15:05", ["stu-02"], { route_code: "RT101" }),
  route("rt-103-pm", "PM", "elementary", "14:30", "15:05", ["stu-03"]),
  route("rt-104-pm", "PM", "middle", "15:00", "15:40", ["stu-04", "stu-05"]),
  route("rt-106-pm", "PM", "high", "14:15", "14:55", ["stu-06", "stu-07"]),
  route("rt-108-pm", "PM", "middle", "15:00", "15:40", ["stu-08"], { flagged: true }),
];

// One already-committed assignment the solver must preserve.
export const demoAssignments: Assignment[] = [
  { driver_id: "drv-4", route_id: "rt-106-am", date: DEMO_DATE },
];

// Canned rows the StubExtractor returns for a fictional manifest upload.
export const demoManifests: Record<string, FieldPassRow[]> = {
  "RT201 Morning.pdf": [
    // Clean row: no flags, every field present -> auto-accept candidate
    { child_name: "Student 21", home_address: "4 Lark St, Fairview", school_address: "100 School Ln, Fairview", school_start_time: "7:50 am", school_end_time: "2:30 pm", requires_accommodation: false, flags: [] },
    // Missing end time -> completeness drops, flagged for review
    { child_name: "Student 22", home_address: "6 Lark St, Fairview", school_address: "100 School Ln, Fairview", school_start_time: "07:50", school_end_time: null, requires_accommodation: false, flags: [] },
    // Three field-pass flags -> model score 0.6, below threshold
    { child_name: "Student 23", home_address: "8 Wren Rd, Fairview", school_address: "200 Campus Dr, Fairview", school_start_time: "08:20", school_end_time: "15:00", requires_accommodation: false, flags: ["Address partially illegible", "Unit number unclear", "Time column shifted"] },
    // Clean row at a different school
    { child_name: "Student 24", home_address: "10 Wren Rd, Fairview", school_address: "200 Campus Dr, Fairview", school_start_time: "8:20 AM", school_end_time: "3:00 PM", requires_accommodation: false, flags: [] },
    // Same student as row 1 repeated across a page break -> deduplicated,
    // keeping the higher-confidence record and carrying its flag forward
    { child_name: "student  21", home_address: "4 Lark St, Fairview", school_address: "100 School Ln, Fairview", school_start_time: "07:50", school_end_time: "14:30", requires_accommodation: false, flags: ["Row split across page break"] },
  ],
};
