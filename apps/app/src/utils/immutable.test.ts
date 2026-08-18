import { describe, it, expect } from "vitest";
import { setIn } from "./immutable";

describe("setIn", () => {
  it("sets a nested leaf value immutably", () => {
    const obj = { a: { b: { c: 1 } } };
    const next = setIn(obj, ["a", "b", "c"], 2);
    expect(next).toEqual({ a: { b: { c: 2 } } });
  });

  it("does not mutate the source", () => {
    const obj = { a: { b: { c: 1 } } };
    setIn(obj, ["a", "b", "c"], 2);
    expect(obj.a.b.c).toBe(1);
  });

  it("clones only the path, preserving sibling references (structural sharing)", () => {
    const shared = { untouched: true };
    const obj = {
      trim: { startTime: 0, endTime: 10 },
      location: shared,
    };
    const next = setIn(obj, ["trim", "endTime"], 99);

    // changed path is a fresh object
    expect(next).not.toBe(obj);
    expect(next.trim).not.toBe(obj.trim);
    expect(next.trim.endTime).toBe(99);

    // untouched sibling keeps the SAME reference — the aliasing bug this fixes
    expect(next.location).toBe(shared);
  });

  it("creates missing intermediate objects", () => {
    const next = setIn({} as any, ["a", "b"], 5);
    expect(next).toEqual({ a: { b: 5 } });
  });

  it("clones arrays as arrays", () => {
    const obj = { list: [1, 2, 3] };
    const next = setIn(obj, ["list", 1], 9);
    expect(Array.isArray(next.list)).toBe(true);
    expect(next.list).toEqual([1, 9, 3]);
    expect(obj.list[1]).toBe(2);
  });

  it("returns the value itself for an empty path", () => {
    expect(setIn({ a: 1 }, [], 42)).toBe(42);
  });
});
