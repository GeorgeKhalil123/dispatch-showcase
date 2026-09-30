import type { Knex } from "knex";

// Core schema. The full system runs this against PostgreSQL (uuid ids via
// pgcrypto); the showcase also runs it against SQLite in tests, so the
// Postgres-only pieces are gated on the client.
const isPg = (knex: Knex) => knex.client.config.client === "pg";

function uuidPk(knex: Knex, t: Knex.CreateTableBuilder): void {
  const col = t.uuid("id").primary();
  if (isPg(knex)) col.defaultTo(knex.raw("gen_random_uuid()"));
}

export async function up(knex: Knex): Promise<void> {
  // Enable uuid generation
  if (isPg(knex)) await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // --- drivers ---
  await knex.schema.createTable("drivers", (t) => {
    uuidPk(knex, t);
    t.string("name", 255).notNullable();
    t.text("home_address").notNullable();
    t.timestamps(true, true); // created_at, updated_at with defaults
  });

  // --- students ---
  await knex.schema.createTable("students", (t) => {
    uuidPk(knex, t);
    t.string("name", 255).notNullable();
    t.text("home_address").notNullable();
    t.text("school_address").notNullable();
    t.time("school_start_time").notNullable();
    t.time("school_end_time").notNullable();
    t.boolean("requires_accommodation").notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  // --- routes ---
  await knex.schema.createTable("routes", (t) => {
    uuidPk(knex, t);
    t.text("school_address").notNullable();
    t.string("type", 2).notNullable();
    t.time("scheduled_start_time").notNullable();
    t.time("scheduled_end_time").notNullable();
    t.boolean("flagged").notNullable().defaultTo(false);
    t.timestamps(true, true);

    t.check("?? IN ('AM', 'PM')", ["type"]);
  });

  // --- route_students (join table) ---
  await knex.schema.createTable("route_students", (t) => {
    t.uuid("route_id").notNullable().references("id").inTable("routes").onDelete("CASCADE");
    t.uuid("student_id").notNullable().references("id").inTable("students").onDelete("CASCADE");
    t.timestamp("created_at", { useTz: true }).defaultTo(knex.fn.now());

    t.primary(["route_id", "student_id"]);
  });

  // --- assignments ---
  await knex.schema.createTable("assignments", (t) => {
    uuidPk(knex, t);
    t.uuid("driver_id").notNullable().references("id").inTable("drivers").onDelete("CASCADE");
    t.uuid("route_id").notNullable().references("id").inTable("routes").onDelete("CASCADE");
    t.date("date").notNullable();
    t.decimal("estimated_miles", 10, 2);
    t.integer("estimated_travel_minutes");
    t.timestamps(true, true);

    // A driver cannot be double-assigned to the same route on the same date.
    t.unique(["driver_id", "route_id", "date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("assignments");
  await knex.schema.dropTableIfExists("route_students");
  await knex.schema.dropTableIfExists("routes");
  await knex.schema.dropTableIfExists("students");
  await knex.schema.dropTableIfExists("drivers");
}
