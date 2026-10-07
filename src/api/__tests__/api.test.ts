import { afterEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { InMemoryRepository } from "../repository";
import { HaversineProvider } from "../../optimizer/travelTime";
import { StubExtractor, type Extractor } from "../../ingest/extractor";
import { DEMO_DATE, demoAssignments, demoDrivers, demoManifests, demoRoutes } from "../../demo/dataset";
import type { OptimizationResult } from "../../optimizer/types";

function makeApp() {
  return createApp({
    repo: new InMemoryRepository(demoDrivers, demoRoutes, demoAssignments),
    travel: new HaversineProvider(),
    extractor: new StubExtractor(demoManifests),
  });
}

describe("POST /optimize", () => {
  it("400s when date is missing", async () => {
    const res = await request(makeApp()).post("/optimize").send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("date");
  });

  it("400s on a non-ISO date", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: "09/08/2026" });
    expect(res.status).toBe(400);
  });

  it("400s on a non-positive buffer", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: DEMO_DATE, buffer_minutes: -5 });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("buffer_minutes");
  });

  it("400s via zod when a field has the wrong type", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: DEMO_DATE, preserve_existing: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Validation failed: preserve_existing/);
  });

  it("400s on malformed JSON instead of crashing", async () => {
    const res = await request(makeApp()).post("/optimize").set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
  });

  it("415s on a form-encoded body instead of crashing", async () => {
    const res = await request(makeApp()).post("/optimize").type("form").send("date=2026-09-08");
    expect(res.status).toBe(415);
    expect(res.body.details).toBeUndefined();
  });

  it("415s on JSON text sent as text/plain", async () => {
    const res = await request(makeApp()).post("/optimize").set("Content-Type", "text/plain").send('{"date":"2026-09-08"}');
    expect(res.status).toBe(415);
  });

  it("400s when there is no body at all", async () => {
    const res = await request(makeApp()).post("/optimize");
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("date");
  });

  it("400s on a date that does not exist", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: "2026-02-30" });
    expect(res.status).toBe(400);
  });

  it("never reports more iterations than max_iterations", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: DEMO_DATE, max_iterations: 5 });
    expect(res.status).toBe(200);
    for (const d of (res.body as OptimizationResult).diagnostics) {
      expect(d.iterations).toBeLessThanOrEqual(5);
    }
  });

  it("400s on a timestamp instead of a date-only value", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: "2026-09-08T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("YYYY-MM-DD");
  });

  it("400s when max_iterations exceeds the default cap", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: DEMO_DATE, max_iterations: 2_000_001 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/^Validation failed: max_iterations/);
  });

  it.each(["5", '"x"', "null"])("400s with a clear message on a top-level JSON %s", async (raw) => {
    const res = await request(makeApp()).post("/optimize").set("Content-Type", "application/json").send(raw);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Request body must be a JSON object");
  });

  it("keeps the parser message for genuinely malformed JSON", async () => {
    const res = await request(makeApp()).post("/optimize").set("Content-Type", "application/json").send("{not json");
    expect(res.body.message).not.toBe("Request body must be a JSON object");
  });

  it("reports preserved assignments separately and stats consistently", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: DEMO_DATE });
    const body = res.body as OptimizationResult;
    expect(body.preserved).toEqual([
      { driver_id: "drv-4", driver_name: "Driver 4", route_id: "rt-106-am", route_type: "AM", route_code: null },
    ]);
    expect(body.stats.preserved).toBe(body.preserved.length);
    expect(body.stats.assigned).toBe(body.preserved.length + body.assignments.length);
    const miles = body.assignments.reduce((s, a) => s + a.estimated_miles, 0);
    expect(body.stats.total_estimated_miles).toBeCloseTo(miles, 2);
  });

  it("returns a proposal that preserves existing assignments for that date", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: DEMO_DATE });
    expect(res.status).toBe(200);
    const body = res.body as OptimizationResult;
    expect(body.stats).toMatchObject({ total_routes: 12, flagged_skipped: 2, assigned: 10, unassigned: 0 });
    // The preserved route is not re-emitted as a new assignment
    expect(body.assignments.map((a) => a.route_id)).not.toContain("rt-106-am");
  });

  it("re-plans the preserved route when preserve_existing is false", async () => {
    const res = await request(makeApp()).post("/optimize").send({ date: DEMO_DATE, preserve_existing: false });
    expect(res.status).toBe(200);
    expect((res.body as OptimizationResult).assignments.map((a) => a.route_id)).toContain("rt-106-am");
  });
});

describe("POST /import/preview", () => {
  it("400s without a filename", async () => {
    const res = await request(makeApp()).post("/import/preview").send({ content: "[]" });
    expect(res.status).toBe(400);
  });

  it("returns scored rows and the review count for a canned manifest", async () => {
    const res = await request(makeApp()).post("/import/preview").send({ filename: "RT201 Morning.pdf" });
    expect(res.status).toBe(200);
    expect(res.body.total_extracted).toBe(4);
    expect(res.body.needs_review).toBe(3);
    expect(res.body.warnings).toContain("Cross-chunk deduplication merged 1 duplicate record(s)");
  });

  it("422s when the document content cannot be parsed", async () => {
    const res = await request(makeApp()).post("/import/preview").send({ filename: "x.pdf", content: "{broken" });
    expect(res.status).toBe(422);
  });
});

describe("POST /import/preview — malformed rows", () => {
  it.each([
    ["a JSON object", '{"a":1}'],
    ["a null row", "[null]"],
    ["a non-string field", '[{"child_name":5}]'],
  ])("422s on %s instead of a 500", async (_label, content) => {
    const res = await request(makeApp()).post("/import/preview").send({ filename: "x.pdf", content });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/^Could not parse document: /);
    expect(res.body.details).toBeUndefined();
  });
});

describe("POST /import/preview — prototype-named files", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"])(
    "treats %s as an ordinary filename",
    async (filename) => {
      const res = await request(makeApp()).post("/import/preview").send({ filename, content: "[]" });
      expect(res.status).toBe(200);
      expect(res.body.total_extracted).toBe(0);
    },
  );
});

describe("GET with a Content-Type but no body", () => {
  it("is not rejected as 415", async () => {
    const res = await request(makeApp()).get("/health").set("Content-Type", "text/plain");
    expect(res.status).toBe(200);
  });
});

describe("unknown routes", () => {
  it("404s with a JSON body", async () => {
    const res = await request(makeApp()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.type).toBe("application/json");
    expect(res.body).toEqual({ status: 404, message: "Not found: GET /nope" });
  });
});

describe("error handler", () => {
  const failing: Extractor = {
    extract: () => Promise.reject(new Error("boom")),
  };
  const failingApp = () =>
    createApp({
      repo: new InMemoryRepository(demoDrivers, demoRoutes, demoAssignments),
      travel: new HaversineProvider(),
      extractor: failing,
    });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("omits the stack on a 500 by default", async () => {
    vi.stubEnv("DISPATCH_DEBUG", "");
    const res = await request(failingApp()).post("/import/preview").send({ filename: "x.pdf" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("boom");
    expect(res.body.details).toBeUndefined();
  });

  it("includes the stack on a 500 only when DISPATCH_DEBUG=1", async () => {
    vi.stubEnv("DISPATCH_DEBUG", "1");
    const res = await request(failingApp()).post("/import/preview").send({ filename: "x.pdf" });
    expect(res.status).toBe(500);
    expect(res.body.details.stack).toContain("boom");
  });
});
