import type { Knex } from "knex";

// Coordinates are added after the fact: addresses arrive from documents first
// and are geocoded (and cached) in a separate pass.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("drivers", (t) => {
    t.decimal("home_latitude", 10, 7);
    t.decimal("home_longitude", 10, 7);
  });

  await knex.schema.alterTable("students", (t) => {
    t.decimal("home_latitude", 10, 7);
    t.decimal("home_longitude", 10, 7);
    t.decimal("school_latitude", 10, 7);
    t.decimal("school_longitude", 10, 7);
  });

  await knex.schema.alterTable("routes", (t) => {
    t.decimal("school_latitude", 10, 7);
    t.decimal("school_longitude", 10, 7);
    t.string("route_code", 50).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("routes", (t) => {
    t.dropColumn("school_latitude");
    t.dropColumn("school_longitude");
    t.dropColumn("route_code");
  });

  await knex.schema.alterTable("students", (t) => {
    t.dropColumn("home_latitude");
    t.dropColumn("home_longitude");
    t.dropColumn("school_latitude");
    t.dropColumn("school_longitude");
  });

  await knex.schema.alterTable("drivers", (t) => {
    t.dropColumn("home_latitude");
    t.dropColumn("home_longitude");
  });
}
