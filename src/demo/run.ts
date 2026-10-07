import { solve } from "../optimizer/solve";
import { HaversineProvider } from "../optimizer/travelTime";
import { groupStudents, refineGroups } from "../grouping/groupStudents";
import { StubExtractor, previewExtraction } from "../ingest/extractor";
import { needsReview } from "../ingest/confidence";
import { InMemoryRepository } from "../api/repository";
import {
  DEMO_DATE,
  demoAssignments,
  demoDrivers,
  demoManifests,
  demoRoutes,
  demoStudents,
} from "./dataset";

// ---------------------------------------------------------------------------
// `npm run demo` — runs the three extracted pipelines on the synthetic
// Fairview dataset: grouping, optimization, and import review routing.
// ---------------------------------------------------------------------------

function heading(title: string): void {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 66 - title.length))}`);
}

async function main(): Promise<void> {
  const travel = new HaversineProvider(45);

  heading("1. Carpool grouping (Union-Find, mode = both)");
  const haversineGroups = groupStudents(demoStudents, "both");
  const { groups } = await refineGroups(haversineGroups, travel);
  for (const g of groups) {
    console.log(
      `${g.id.padEnd(10)} ${g.students.map((s) => s.name).join(", ").padEnd(24)} ` +
      `-> ${g.school_address}  window ${g.school_start_time}-${g.school_end_time}`,
    );
  }
  const accommodation = demoStudents.filter((s) => s.requires_accommodation).length;
  console.log(`(${accommodation} student(s) needing accommodation left out of grouping)`);

  heading("2. Optimization (greedy seed -> backtracking, buffer 10 min)");
  // Load through the same repository the API uses, so the demo and
  // POST /optimize see routes in the same (start-time) order.
  const repo = new InMemoryRepository(demoDrivers, demoRoutes, demoAssignments);
  const [drivers, routes, existing] = await Promise.all([repo.listDrivers(), repo.listRoutes(), repo.listAssignments(DEMO_DATE)]);
  console.log(`${drivers.length} drivers, ${routes.length} routes, ${existing.length} preserved assignment(s), provider = ${travel.name}`);
  const result = await solve({ drivers, routes, existing }, travel, { buffer_minutes: 10 });
  for (const d of result.diagnostics) {
    console.log(
      `[${d.period}] ${d.candidates} flexible candidate(s): greedy seed ${d.seed_assigned ?? "n/a"} covered / ${d.seed_miles ?? "n/a"} mi, ` +
      `backtracking ${d.assigned} covered / ${d.miles} mi (${d.iterations.toLocaleString("en-US")} iterations)`,
    );
  }
  console.log("");
  // Preserved assignments are counted in stats.assigned but not re-emitted
  // by the solver, so print them from the input.
  for (const e of existing) {
    const route = routes.find((r) => r.route.id === e.route_id)?.route;
    const driver = drivers.find((d) => d.id === e.driver_id);
    console.log(`${route?.type ?? "??"}  ${e.route_id.padEnd(11)} ${(driver?.name ?? e.driver_id).padEnd(9)} (preserved)`);
  }
  for (const a of result.assignments) {
    const merged = a.trip_group_ids && a.trip_group_ids.length > 1 ? ` (shared trip x${a.trip_group_ids.length})` : "";
    console.log(
      `${a.route_type}  ${a.route_id.padEnd(11)} ${a.driver_name.padEnd(9)} ` +
      `${a.estimated_miles.toFixed(2).padStart(6)} mi ${String(a.estimated_travel_minutes).padStart(3)} min${merged}`,
    );
  }
  for (const u of result.unassigned) console.log(`UNASSIGNED ${u.route_id}: ${u.reason}`);
  console.log("");
  console.log(JSON.stringify(result.stats));
  for (const w of result.warnings) console.log(`warning: ${w}`);

  heading("3. Import preview (stub extractor, review routing)");
  const extractor = new StubExtractor(demoManifests);
  const preview = await previewExtraction(extractor, "RT201 Morning.pdf", "");
  console.log(`${preview.filename}: ${preview.total_extracted} row(s), ${preview.needs_review} need review`);
  for (const r of preview.routes) {
    const status = needsReview(r) ? "REVIEW" : "ok    ";
    console.log(`${status} ${String(r.child_name).padEnd(11)} conf=${r.confidence.toFixed(2)}  ${r.flags.join("; ")}`);
  }
  for (const w of preview.warnings) console.log(`warning: ${w}`);
  console.log(`\n(date ${DEMO_DATE}; all data is synthetic)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
