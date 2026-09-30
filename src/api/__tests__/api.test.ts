import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { InMemoryRepository } from "../repository";
import { HaversineProvider } from "../../optimizer/travelTime";
import { StubExtractor } from "../../ingest/extractor";
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
