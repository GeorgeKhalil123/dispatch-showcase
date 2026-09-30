import type { Assignment, Driver } from "../shared/types";
import type { RouteWithStudents } from "../optimizer/solve";

// ---------------------------------------------------------------------------
// Read side of the data layer. The full system implements this over
// PostgreSQL via Knex (see src/db/migrations for the schema shape); the
// showcase ships an in-memory implementation.
// ---------------------------------------------------------------------------

export interface DispatchRepository {
  listDrivers(): Promise<Driver[]>;
  listRoutes(): Promise<RouteWithStudents[]>;
  listAssignments(date: string): Promise<Assignment[]>;
}

export class InMemoryRepository implements DispatchRepository {
  constructor(
    private readonly drivers: Driver[] = [],
    private readonly routes: RouteWithStudents[] = [],
    private readonly assignments: Assignment[] = [],
  ) {}

  async listDrivers(): Promise<Driver[]> {
    return [...this.drivers].sort((a, b) => a.name.localeCompare(b.name));
  }

  async listRoutes(): Promise<RouteWithStudents[]> {
    return [...this.routes].sort((a, b) => a.route.scheduled_start_time.localeCompare(b.route.scheduled_start_time));
  }

  async listAssignments(date: string): Promise<Assignment[]> {
    return this.assignments.filter((a) => a.date === date);
  }
}
