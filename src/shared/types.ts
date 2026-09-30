// ---------------------------------------------------------------------------
// Domain types shared across the optimizer, grouping, ingest and API layers.
// Trimmed from the full system's shared types: pay/cost columns and audit
// fields that only the private cost calculator reads are left out.
// ---------------------------------------------------------------------------

export interface Driver {
  id: string;
  name: string;
  home_address: string;
  home_latitude: number | null;
  home_longitude: number | null;
}

export interface Student {
  id: string;
  name: string;
  home_address: string;
  home_latitude: number | null;
  home_longitude: number | null;
  school_address: string;
  school_latitude: number | null;
  school_longitude: number | null;
  school_start_time: string; // HH:MM format
  school_end_time: string;   // HH:MM format
  requires_accommodation: boolean;
}

export interface Route {
  id: string;
  school_address: string;
  school_latitude: number | null;
  school_longitude: number | null;
  type: "AM" | "PM";
  scheduled_start_time: string;
  scheduled_end_time: string;
  route_code: string | null; // alphanumeric code from the source document
  flagged: boolean;          // true if any student requires accommodation
}

export interface Assignment {
  driver_id: string;
  route_id: string;
  date: string; // ISO date
}

// Fields extracted from one row of an uploaded route manifest. Every field is
// nullable because extraction can miss any of them; `confidence` and `flags`
// drive whether the row lands in the human review queue.
export interface ExtractedRoute {
  child_name: string | null;
  home_address: string | null;
  school_address: string | null;
  school_start_time: string | null;
  school_end_time: string | null;
  requires_accommodation: boolean;
  confidence: number;
  flags: string[];
  route_code: string | null;
}
