import { describe, expect, it } from "vitest";
import { createPaintHold } from "./paintHold";

describe("createPaintHold", () => {
  it("turns throttling off for the first hold and back on after the last release", async () => {
    const calls: boolean[] = [];
    const hold = createPaintHold((allowed) => void calls.push(allowed));
    const releaseExport = await hold.hold();
    const releaseSheet = await hold.hold();
    expect(calls).toEqual([false]);
    await releaseExport();
    expect(calls).toEqual([false]);
    await releaseSheet();
    expect(calls).toEqual([false, true]);
    expect(hold.holders).toBe(0);
  });

  it("counts a release once, however often it is called", async () => {
    const calls: boolean[] = [];
    const hold = createPaintHold((allowed) => void calls.push(allowed));
    const a = await hold.hold();
    const b = await hold.hold();
    await a();
    await a();
    expect(hold.holders).toBe(1);
    expect(calls).toEqual([false]);
    await b();
    expect(calls).toEqual([false, true]);
  });

  it("survives a bridge that throws, and still counts", async () => {
    const hold = createPaintHold(() => {
      throw new Error("no bridge");
    });
    const release = await hold.hold();
    expect(hold.holders).toBe(1);
    await release();
    expect(hold.holders).toBe(0);
  });
});
