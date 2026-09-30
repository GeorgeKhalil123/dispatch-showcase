import { describe, it, expect, beforeEach, afterEach } from "vitest";
import knexFactory, { type Knex } from "knex";
import { migrationSource } from "../migrationSource";

// Runs the illustrative migrations against in-memory SQLite. The full system
// runs the same pattern against PostgreSQL.
let knex: Knex;

beforeEach(() => {
  knex = knexFactory({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true,
    migrations: { migrationSource },
  });
});

afterEach(async () => {
  await knex.destroy();
});

async function indexNames(table: string): Promise<string[]> {
  const rows: Array<{ name: string }> = await knex.raw(`PRAGMA index_list(${table})`);
  return rows.map((r) => r.name);
}

describe("migrations", () => {
  it("migrate:latest creates the core tables and geocoding columns", async () => {
    const [, applied] = await knex.migrate.latest();
    expect(applied).toEqual(["01_create_core_tables", "02_add_geocoding_columns", "03_add_performance_indexes"]);

    for (const table of ["drivers", "students", "routes", "route_students", "assignments"]) {
      expect(await knex.schema.hasTable(table)).toBe(true);
    }
    expect(await knex.schema.hasColumn("routes", "school_latitude")).toBe(true);
    expect(await knex.schema.hasColumn("routes", "route_code")).toBe(true);
    expect(await indexNames("assignments")).toEqual(expect.arrayContaining(["idx_assignments_date", "idx_assignments_driver_id_date"]));
  });

  it("enforces the AM/PM check constraint on routes.type", async () => {
    await knex.migrate.latest();
    const base = { school_address: "100 School Ln", scheduled_start_time: "07:00", scheduled_end_time: "08:00" };
    await knex("routes").insert({ id: "r-am", type: "AM", ...base });
    await expect(knex("routes").insert({ id: "r-bad", type: "XX", ...base })).rejects.toThrow(/CHECK constraint failed/);
  });

  it("rejects a double-assignment of the same driver and route on the same date", async () => {
    await knex.migrate.latest();
    await knex("drivers").insert({ id: "d1", name: "Driver 1", home_address: "11 Birch St" });
    await knex("routes").insert({ id: "r1", type: "AM", school_address: "100 School Ln", scheduled_start_time: "07:00", scheduled_end_time: "08:00" });
    const row = { driver_id: "d1", route_id: "r1", date: "2026-09-08" };
    await knex("assignments").insert({ id: "a1", ...row });
    await expect(knex("assignments").insert({ id: "a2", ...row })).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("rolls every migration back cleanly", async () => {
    await knex.migrate.latest();
    await knex.migrate.rollback(undefined, true);
    for (const table of ["drivers", "students", "routes", "route_students", "assignments"]) {
      expect(await knex.schema.hasTable(table)).toBe(false);
    }
  });
});
