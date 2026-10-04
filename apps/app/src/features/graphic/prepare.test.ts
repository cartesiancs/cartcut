import { describe, expect, it } from "vitest";
import type { ApplyState, HtmlRasterPort, MountSpec } from "./htmlRasterPort";
import type { GraphicJob } from "./planGraphics";
import { prepareGraphics, type RasterSink } from "./prepare";
import { beginExportGraphics, endExportGraphics, previewMayPrepare, serialize } from "./graphicQueue";

/** A host that records the order of calls, the contract `prepare` keeps. */
function fakePort(painted = true) {
  const calls: string[] = [];
  const port: HtmlRasterPort = {
    supported: () => true,
    mount: (id: string, spec: MountSpec) => void calls.push(`mount ${id} ${spec.programKey}`),
    apply: (id: string, state: ApplyState) => void calls.push(`apply ${id} ${JSON.stringify(state.vars)}`),
    settle: async () => {
      calls.push("settle");
      return painted;
    },
    rasterize: (id: string, w: number, h: number) => {
      calls.push(`rasterize ${id} ${w}x${h}`);
      return { id } as unknown as CanvasImageSource;
    },
    release: () => undefined,
    unmount: () => undefined,
  };
  return { port, calls };
}

function job(id: string, key: string): GraphicJob {
  return {
    instanceId: id,
    element: {} as any,
    preset: {} as any,
    key,
    time: { tMs: 0, durMs: 1, progress: 0, localMs: 0 },
    vars: { "--angle": "1", "--t": "0" },
    texts: {},
    layoutBox: { width: 10, height: 10 },
    bleed: 0,
    raster: { width: 10, height: 10 },
    seed: 0,
    static: false,
  };
}

const spec: MountSpec = {
  programKey: "p1",
  nodes: [],
  css: "",
  propertyRules: "",
  renames: { "--angle": "--gabc-angle" },
  assetUrls: {},
  programHash: "abc",
};

function sink(): RasterSink & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return { keys, keyOf: (id) => keys.get(id) ?? null, put: (id, key) => void keys.set(id, key) };
}

describe("prepareGraphics", () => {
  it("applies everything, settles once, then rasterises each", async () => {
    const { port, calls } = fakePort();
    const s = sink();
    const result = await prepareGraphics(
      { port, mountOf: () => ({ spec, removed: [] }), fontsOf: () => [] },
      [job("a", "k1"), job("b", "k2")],
      s,
    );
    expect(calls.map((c) => c.split(" ")[0])).toEqual([
      "mount", "apply", "mount", "apply", "settle", "rasterize", "rasterize",
    ]);
    expect(result).toEqual({ drawn: 2, current: 0, painted: true });
    expect([...s.keys.entries()]).toEqual([["a", "k1"], ["b", "k2"]]);
  });

  it("renames a registered property in the variables it sets", async () => {
    const { port, calls } = fakePort();
    await prepareGraphics({ port, mountOf: () => ({ spec, removed: [] }), fontsOf: () => [] }, [job("a", "k")], sink());
    expect(calls[1]).toContain('"--gabc-angle":"1"');
    expect(calls[1]).not.toContain('"--angle"');
  });

  it("does nothing at all for a raster that is already current", async () => {
    const { port, calls } = fakePort();
    const s = sink();
    s.keys.set("a", "k1");
    const result = await prepareGraphics({ port, mountOf: () => ({ spec, removed: [] }), fontsOf: () => [] }, [job("a", "k1")], s);
    expect(calls).toEqual([]);
    expect(result).toEqual({ drawn: 0, current: 1, painted: true });
  });

  it("reports a paint that never came", async () => {
    const { port } = fakePort(false);
    const result = await prepareGraphics({ port, mountOf: () => ({ spec, removed: [] }), fontsOf: () => [] }, [job("a", "k")], sink());
    expect(result.painted).toBe(false);
  });

  it("does nothing where html-in-canvas is not available", async () => {
    const { port, calls } = fakePort();
    port.supported = () => false;
    const result = await prepareGraphics({ port, mountOf: () => ({ spec, removed: [] }), fontsOf: () => [] }, [job("a", "k")], sink());
    expect(calls).toEqual([]);
    expect(result.drawn).toBe(0);
  });
});

describe("graphicQueue", () => {
  it("runs tasks one at a time, in order, even when one fails", async () => {
    const order: string[] = [];
    const slow = serialize(async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("first");
      throw new Error("boom");
    });
    const fast = serialize(async () => {
      order.push("second");
    });
    await expect(slow).rejects.toThrow("boom");
    await fast;
    expect(order).toEqual(["first", "second"]);
  });

  it("stops the preview preparing while an export holds the host", () => {
    expect(previewMayPrepare()).toBe(true);
    beginExportGraphics();
    expect(previewMayPrepare()).toBe(false);
    endExportGraphics();
    expect(previewMayPrepare()).toBe(true);
  });
});
