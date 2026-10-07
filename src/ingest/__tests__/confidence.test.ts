import { describe, it, expect } from "vitest";
import {
  completenessScore,
  dedupeRows,
  extractRouteCode,
  flagScore,
  needsReview,
  normalizeRow,
  normalizeTime,
} from "../confidence";
import { ExtractionError, StubExtractor, previewExtraction, type FieldPassRow } from "../extractor";
import type { ExtractedRoute } from "../../shared/types";

function row(overrides: Partial<FieldPassRow> = {}): FieldPassRow {
  return {
    child_name: "Student 1",
    home_address: "1 Lark St",
    school_address: "100 School Ln",
    school_start_time: "08:00",
    school_end_time: "15:00",
    requires_accommodation: false,
    flags: [],
    ...overrides,
  };
}

function extracted(overrides: Partial<ExtractedRoute> = {}): ExtractedRoute {
  return { ...row(), confidence: 0.9, route_code: null, ...overrides };
}

describe("flagScore", () => {
  it("is 0.9 with no flags and drops 0.1 per flag", () => {
    expect(flagScore([])).toBe(0.9);
    expect(flagScore(["a"])).toBeCloseTo(0.8);
    expect(flagScore(["a", "b", "c"])).toBeCloseTo(0.6);
  });

  it("floors at 0.4 no matter how many flags", () => {
    expect(flagScore(Array(5).fill("x"))).toBe(0.4);
    expect(flagScore(Array(20).fill("x"))).toBe(0.4);
  });
});

describe("completenessScore", () => {
  it("costs 0.15 per missing critical field, floored at 0", () => {
    expect(completenessScore(0)).toBe(1);
    expect(completenessScore(2)).toBeCloseTo(0.7);
    expect(completenessScore(7)).toBe(0);
  });
});

describe("normalizeRow", () => {
  it("takes the LOWER of completeness and model score", () => {
    // One missing field -> completeness 0.85; model 0.9 -> final 0.85
    expect(normalizeRow({ ...row({ school_end_time: null }), confidence: 0.9 }, null).confidence).toBeCloseTo(0.85);
    // Complete row -> completeness 1; model 0.6 -> final 0.6
    expect(normalizeRow({ ...row(), confidence: 0.6 }, null).confidence).toBeCloseTo(0.6);
  });

  it("adds a model-uncertainty flag below the 0.7 threshold, once", () => {
    const low = normalizeRow({ ...row(), confidence: 0.55 }, null);
    expect(low.flags).toContain("Model uncertainty: 55%");
    const already = normalizeRow({ ...row({ flags: ["Uncertain spelling"] }), confidence: 0.55 }, null);
    expect(already.flags).toEqual(["Uncertain spelling"]);
  });

  it("treats a missing or non-numeric model score as 0.5 and clamps out-of-range scores", () => {
    expect(normalizeRow({ ...row(), confidence: "high" }, null).confidence).toBe(0.5);
    expect(normalizeRow({ ...row(), confidence: 7 }, null).confidence).toBe(1);
  });

  it("flags each missing field and normalizes 12-hour times", () => {
    const r = normalizeRow({ child_name: null, home_address: "1 Lark St", school_start_time: "7:50 am", school_end_time: "2:30 p.m.", confidence: 0.9 }, "RT1");
    expect(r.flags).toEqual(expect.arrayContaining(["Missing child name", "Missing school address"]));
    expect(r.school_start_time).toBe("07:50");
    expect(r.school_end_time).toBe("14:30");
    expect(r.route_code).toBe("RT1");
  });
});

describe("needsReview", () => {
  it("routes a row to review when confidence < 0.7 OR it carries any flag", () => {
    expect(needsReview({ confidence: 0.9, flags: [] })).toBe(false);
    expect(needsReview({ confidence: 0.69, flags: [] })).toBe(true);
    expect(needsReview({ confidence: 0.95, flags: ["Row split across page break"] })).toBe(true);
    expect(needsReview({ confidence: 0.7, flags: [] })).toBe(false);
  });
});

describe("dedupeRows", () => {
  it("keeps the higher-confidence record in the first-seen position and unions flags", () => {
    const first = extracted({ child_name: "Student 1", confidence: 0.6, school_end_time: null, flags: ["Missing end time"] });
    const other = extracted({ child_name: "Student 2", home_address: "2 Lark St" });
    const dup = extracted({ child_name: "  student 1 ", confidence: 0.8, flags: ["Row split across page break"] });
    const { routes, merged } = dedupeRows([first, other, dup]);
    expect(merged).toBe(1);
    expect(routes).toHaveLength(2);
    expect(routes[0].confidence).toBe(0.8);
    expect(routes[0].school_end_time).toBe("15:00");
    expect(routes[0].flags.sort()).toEqual(["Missing end time", "Row split across page break"]);
  });

  it("never merges rows with neither a name nor an address", () => {
    const blank = extracted({ child_name: null, home_address: null });
    expect(dedupeRows([blank, { ...blank }]).routes).toHaveLength(2);
  });
});

describe("helpers", () => {
  it("extractRouteCode takes the first alphanumeric filename token", () => {
    expect(extractRouteCode("RT201 Morning.pdf")).toBe("RT201");
    expect(extractRouteCode("route-7.pdf")).toBeNull();
    expect(extractRouteCode(".pdf")).toBeNull();
  });

  it("normalizeTime rejects unparseable values", () => {
    expect(normalizeTime("noon")).toBeNull();
    expect(normalizeTime(830)).toBeNull();
    expect(normalizeTime("12:05 am")).toBe("00:05");
  });
});

describe("previewExtraction (stub extractor)", () => {
  it("scores canned rows end to end and counts the review queue", async () => {
    const extractor = new StubExtractor({
      "RT9 Test.pdf": [
        row(),
        row({ child_name: "Student 2", home_address: "2 Lark St", flags: ["Address partially illegible", "Unit unclear", "Time shifted"] }),
        row({ child_name: "Student 3", home_address: "3 Lark St", school_start_time: null }),
      ],
    });
    const preview = await previewExtraction(extractor, "RT9 Test.pdf", "");
    expect(preview.total_extracted).toBe(3);
    expect(preview.needs_review).toBe(2);
    expect(preview.routes[0]).toMatchObject({ confidence: 0.9, flags: [], route_code: "RT9" });
    expect(preview.routes[1].confidence).toBeCloseTo(0.6);
    expect(preview.routes[1].flags).toContain("Model uncertainty: 60%");
  });

  it("falls back to parsing JSON content when no canned rows exist", async () => {
    const preview = await previewExtraction(new StubExtractor(), "upload.pdf", JSON.stringify([row()]));
    expect(preview.total_extracted).toBe(1);
    expect(preview.routes[0].route_code).toBe("upload");
  });

  it("fills omitted fields in parsed content as not extracted", async () => {
    const [parsed] = await new StubExtractor().extract("upload.pdf", JSON.stringify([{ child_name: "Student 1" }]));
    expect(parsed).toEqual({
      child_name: "Student 1",
      home_address: null,
      school_address: null,
      school_start_time: null,
      school_end_time: null,
      requires_accommodation: false,
      flags: [],
    });
  });

  it("rejects parsed content that is not an array of row objects", async () => {
    const extractor = new StubExtractor();
    await expect(extractor.extract("x.pdf", '{"a":1}')).rejects.toThrow(ExtractionError);
    await expect(extractor.extract("x.pdf", "[null]")).rejects.toThrow(/row 0/);
    await expect(extractor.extract("x.pdf", '[{"child_name":5}]')).rejects.toThrow(/row 0\.child_name/);
    await expect(extractor.extract("x.pdf", '[{"flags":"none"}]')).rejects.toThrow(/row 0\.flags/);
  });

  it("warns when nothing was extracted", async () => {
    const preview = await previewExtraction(new StubExtractor(), "empty.pdf", "");
    expect(preview.total_extracted).toBe(0);
    expect(preview.warnings).toContain("No student rows were extracted from this document");
  });
});
