import type { Knex } from "knex";
import * as m01 from "./migrations/01_create_core_tables";
import * as m02 from "./migrations/02_add_geocoding_columns";
import * as m03 from "./migrations/03_add_performance_indexes";

// Migrations are registered statically instead of discovered from disk, so
// the same list runs under tsx, vitest and a compiled build without any
// loader configuration.
const MIGRATIONS: Record<string, Knex.Migration> = {
  "01_create_core_tables": m01,
  "02_add_geocoding_columns": m02,
  "03_add_performance_indexes": m03,
};

export const migrationSource: Knex.MigrationSource<string> = {
  async getMigrations() {
    return Object.keys(MIGRATIONS).sort();
  },
  getMigrationName(name) {
    return name;
  },
  async getMigration(name) {
    if (!Object.hasOwn(MIGRATIONS, name)) throw new Error(`Unknown migration: ${name}`);
    return MIGRATIONS[name];
  },
};
