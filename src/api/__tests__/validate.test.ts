import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  httpError,
  requireFields,
  pickFields,
  validateDate,
  validateEnum,
  validatePositiveNumber,
} from "../validate";

function makeReq(body: unknown): Request {
  return { body } as Request;
}

function collectNext() {
  const next = vi.fn() as unknown as NextFunction;
  return next;
}

describe("httpError", () => {
  it("attaches the given status code, defaulting to 400", () => {
    const err = httpError("bad request");
    expect(err.message).toBe("bad request");
    expect(err.status).toBe(400);
  });

  it("uses a custom status when provided", () => {
    const err = httpError("not found", 404);
    expect(err.status).toBe(404);
  });
});

describe("requireFields", () => {
  it("calls next() with no error when all fields are present", () => {
    const next = collectNext();
    requireFields("name", "email")(makeReq({ name: "A", email: "a@b.com" }), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("calls next(err) listing every missing field", () => {
    const next = collectNext();
    requireFields("name", "email")(makeReq({ name: "A" }), {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.status).toBe(400);
    expect(err.message).toContain("email");
  });

  it("treats an empty string as missing (not merely undefined/null)", () => {
    const next = collectNext();
    requireFields("name")(makeReq({ name: "" }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.message).toContain("name");
  });
});

describe("pickFields", () => {
  it("keeps only allowed keys present on the body", () => {
    const picked = pickFields({ a: 1, b: 2, c: 3 }, ["a", "c"] as const);
    expect(picked).toEqual({ a: 1, c: 3 });
  });

  it("silently drops disallowed keys (e.g. id/created_at) instead of throwing", () => {
    const picked = pickFields({ id: "x", name: "n", created_at: "t" }, ["name"] as const);
    expect(picked).toEqual({ name: "n" });
  });

  it("returns an empty object for non-object bodies (null, array-less guard)", () => {
    expect(pickFields(null, ["a"] as const)).toEqual({});
    expect(pickFields("string", ["a"] as const)).toEqual({});
  });
});

describe("validateDate", () => {
  it("passes through when the field is absent", () => {
    const next = collectNext();
    validateDate("date")(makeReq({}), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("accepts a plain YYYY-MM-DD date", () => {
    const next = collectNext();
    validateDate("date")(makeReq({ date: "2026-07-30" }), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("accepts a full ISO timestamp", () => {
    const next = collectNext();
    validateDate("date")(makeReq({ date: "2026-07-30T12:00:00Z" }), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a non-ISO-shaped string", () => {
    const next = collectNext();
    validateDate("date")(makeReq({ date: "07/30/2026" }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.status).toBe(400);
    expect(err.message).toContain("date");
  });

  it("rejects a value that matches the regex shape but fails to parse (e.g. month 13)", () => {
    const next = collectNext();
    validateDate("date")(makeReq({ date: "2026-13-99" }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.status).toBe(400);
  });

  it("rejects a non-string value", () => {
    const next = collectNext();
    validateDate("date")(makeReq({ date: 12345 }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.status).toBe(400);
  });
});

describe("validateEnum", () => {
  it("passes through when the field is absent", () => {
    const next = collectNext();
    validateEnum("type", ["AM", "PM"] as const)(makeReq({}), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("accepts a value in the allowed set", () => {
    const next = collectNext();
    validateEnum("type", ["AM", "PM"] as const)(makeReq({ type: "AM" }), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects a value outside the allowed set", () => {
    const next = collectNext();
    validateEnum("type", ["AM", "PM"] as const)(makeReq({ type: "NOON" }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.status).toBe(400);
    expect(err.message).toContain("type");
    expect(err.message).toContain("AM, PM");
  });
});

describe("validatePositiveNumber", () => {
  it("passes through when the field is absent", () => {
    const next = collectNext();
    validatePositiveNumber("rate")(makeReq({}), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("accepts a positive numeric string, coercing it", () => {
    const next = collectNext();
    validatePositiveNumber("rate")(makeReq({ rate: "12.5" }), {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("rejects zero (must be strictly positive)", () => {
    const next = collectNext();
    validatePositiveNumber("rate")(makeReq({ rate: 0 }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.status).toBe(400);
  });

  it("rejects negative numbers", () => {
    const next = collectNext();
    validatePositiveNumber("rate")(makeReq({ rate: -5 }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.status).toBe(400);
  });

  it("rejects non-numeric strings", () => {
    const next = collectNext();
    validatePositiveNumber("rate")(makeReq({ rate: "abc" }), {} as Response, next);
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(err.status).toBe(400);
  });
});
