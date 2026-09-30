import type { Knex } from "knex";

// ─── NOTE ─────────────────────────────────────────────────────────────────────
// Migration 01's t.unique(["driver_id", "route_id", "date"]) already enforces
// the optimizer's idempotency invariant and gives an index led by driver_id.
// These cover the remaining hot read paths. CREATE INDEX IF NOT EXISTS is
// valid in both PostgreSQL and SQLite.
// ─────────────────────────────────────────────────────────────────────────────

export async function up(knex: Knex): Promise<void> {
  // assignments(date)
  // Used by: optimizer's preserve_existing load, dashboard stats.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_assignments_date ON assignments (date)`);

  // assignments(driver_id, date)
  // Used by: driver timeline queries and per-driver lookups on a date.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_assignments_driver_id_date ON assignments (driver_id, date)`);

  // route_students(route_id)
  // Used by: optimizer route-student fetch and route detail endpoints.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_route_students_route_id ON route_students (route_id)`);

  // routes(type, flagged)
  // Used by: the optimizer's initial route load (WHERE type = ? AND flagged = FALSE).
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_routes_type_flagged ON routes (type, flagged)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_assignments_date`);
  await knex.raw(`DROP INDEX IF EXISTS idx_assignments_driver_id_date`);
  await knex.raw(`DROP INDEX IF EXISTS idx_route_students_route_id`);
  await knex.raw(`DROP INDEX IF EXISTS idx_routes_type_flagged`);
}
