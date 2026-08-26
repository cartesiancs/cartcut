import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __setPresetsForTesting,
  defaultParamsFor,
  loadPresets,
  presetById,
  presetFailures,
  presetsLoaded,
  presetsOfKind,
  subscribePresets,
  userPresetDirectory,
} from "./presetRegistry";
import type { RawPresetPayload } from "./presetTypes";

const SHADER = [
  "vec4 transition(vec2 uv) {",
  "  return mix(getFromColor(uv), getToColor(uv), progress);",
  "}",
].join("\n");

const EFFECT_SHADER = [
  "vec4 effect(vec2 uv) {",
  "  return getSourceColor(uv);",
  "}",
].join("\n");

function payload(
  over: Partial<RawPresetPayload> & { manifest?: unknown } = {},
): RawPresetPayload {
  const { manifest, ...rest } = over;
  return {
    id: "folder",
    dir: "/presets/folder",
    origin: "user",
    manifestJson: JSON.stringify(
      manifest ?? {
        schema: 1,
        id: "com.example.a",
        kind: "transition",
        name: "A",
        category: "dissolve",
        render: { type: "shader", source: "shader.frag" },
        params: [],
      },
    ),
    sources: { "shader.frag": SHADER },
    assets: {},
    ...rest,
  };
}

/** Stand in for the preload bridge without needing a `window`. */
function installBridge(presets: RawPresetPayload[]) {
  (globalThis as any).electronAPI = {
    req: {
      preset: {
        list: async () => ({ presets }),
        userDirectory: async () => ({ path: "/home/u/.config/presets" }),
      },
    },
  };
}

beforeEach(() => {
  __setPresetsForTesting([]);
});

afterEach(() => {
  delete (globalThis as any).electronAPI;
  vi.restoreAllMocks();
});

describe("loadPresets", () => {
  it("validates what the bridge returns and indexes it by manifest id", async () => {
    installBridge([payload()]);
    await loadPresets();

    // Keyed by the manifest's `id`, not by the folder name — two people can
    // name a folder `rain` without colliding.
    expect(presetById("com.example.a")?.name).toBe("A");
    expect(presetById("folder")).toBeNull();
    expect(presetsLoaded()).toBe(true);
  });

  it("drops a bad preset and keeps the rest", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installBridge([
      payload({ id: "broken", manifestJson: "{ not json" }),
      payload(),
    ]);
    await loadPresets();

    // One bad folder in userData must not cost the user their other presets.
    expect(presetById("com.example.a")).not.toBeNull();
    expect(presetFailures()).toHaveLength(1);
    expect(presetFailures()[0].id).toBe("broken");
  });

  it("refuses a second preset claiming an id that is taken", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installBridge([
      payload({ id: "first" }),
      payload({ id: "second", dir: "/presets/second" }),
    ]);
    await loadPresets();

    // Built-ins are enumerated first, so this is also what stops a user preset
    // silently shadowing one that ships with the app.
    expect(presetFailures()).toHaveLength(1);
    expect(presetFailures()[0].errors.join()).toContain("already used");
  });

  it("survives having no bridge at all", async () => {
    // The offscreen export window and the node test environment both have no
    // `window`, let alone a preload bridge. A bare `window` reference would be
    // a ReferenceError rather than undefined.
    delete (globalThis as any).electronAPI;
    await expect(loadPresets()).resolves.toBeUndefined();
    expect(presetsOfKind("transition")).toEqual([]);
  });

  it("survives a bridge that throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as any).electronAPI = {
      req: {
        preset: {
          list: async () => {
            throw new Error("EACCES");
          },
        },
      },
    };
    await expect(loadPresets()).resolves.toBeUndefined();
    expect(presetsOfKind("transition")).toEqual([]);
  });

  it("re-reads the disk on a second call, for Install preset…", async () => {
    installBridge([payload()]);
    await loadPresets();
    expect(presetsOfKind("transition")).toHaveLength(1);

    installBridge([]);
    await loadPresets();
    expect(presetsOfKind("transition")).toHaveLength(0);
  });
});

describe("presetsOfKind", () => {
  it("separates the two kinds", async () => {
    installBridge([
      payload(),
      payload({
        id: "fx",
        dir: "/presets/fx",
        sources: { "shader.frag": EFFECT_SHADER },
        manifest: {
          schema: 1,
          id: "com.example.b",
          kind: "effect",
          name: "B",
          category: "color",
          render: { type: "shader", source: "shader.frag" },
          params: [],
        },
      }),
    ]);
    await loadPresets();

    expect(presetsOfKind("transition").map((p) => p.id)).toEqual([
      "com.example.a",
    ]);
    expect(presetsOfKind("effect").map((p) => p.id)).toEqual([
      "com.example.b",
    ]);
  });

  it("lists built-ins before user presets, then by name", async () => {
    const make = (
      id: string,
      name: string,
      origin: "builtin" | "user",
    ): RawPresetPayload =>
      payload({
        id,
        dir: "/presets/" + id,
        origin,
        manifest: {
          schema: 1,
          id,
          kind: "transition",
          name,
          category: "dissolve",
          render: { type: "shader", source: "shader.frag" },
          params: [],
        },
      });

    installBridge([
      make("u.zebra", "Zebra", "user"),
      make("u.apple", "Apple", "user"),
      make("b.mango", "Mango", "builtin"),
    ]);
    await loadPresets();

    expect(presetsOfKind("transition").map((p) => p.name)).toEqual([
      "Mango",
      "Apple",
      "Zebra",
    ]);
  });
});

describe("defaultParamsFor", () => {
  it("seeds every declared parameter", async () => {
    installBridge([
      payload({
        sources: {
          "shader.frag": "uniform float amount;\n" + SHADER,
        },
        manifest: {
          schema: 1,
          id: "com.example.a",
          kind: "transition",
          name: "A",
          category: "dissolve",
          render: { type: "shader", source: "shader.frag" },
          params: [
            {
              key: "amount",
              label: "Amount",
              type: "number",
              uniform: "amount",
              default: 0.25,
              min: 0,
              max: 1,
            },
          ],
        },
      }),
    ]);
    await loadPresets();

    expect(defaultParamsFor("com.example.a")).toEqual({ amount: 0.25 });
  });

  it("returns nothing for a preset that is not installed", () => {
    // The missing-preset path: the element keeps its own params, the
    // compositor draws a pass-through, and nothing throws.
    expect(defaultParamsFor("com.nobody.missing")).toEqual({});
    expect(presetById("com.nobody.missing")).toBeNull();
  });
});

describe("userPresetDirectory", () => {
  it("returns the path the main process created", async () => {
    installBridge([]);
    expect(await userPresetDirectory()).toBe("/home/u/.config/presets");
  });

  it("returns null with no bridge rather than throwing", async () => {
    delete (globalThis as any).electronAPI;
    expect(await userPresetDirectory()).toBeNull();
  });
});

describe("subscribePresets", () => {
  it("fires when a load completes, so the timeline can relabel", () => {
    // The timeline paints long before `loadPresets` resolves, and an effect
    // clip is labelled with its preset's name. Without this notification the
    // clip showed its raw preset id until an unrelated edit repainted it.
    const seen: number[] = [];
    const stop = subscribePresets(() => seen.push(1));

    installBridge([payload()]);
    return loadPresets().then(() => {
      expect(seen).toHaveLength(1);
      stop();
      return loadPresets().then(() => {
        expect(seen).toHaveLength(1);
      });
    });
  });

  it("fires even when the load found nothing", () => {
    // "No presets are installed" is as much a change from "not loaded yet" as
    // finding some is, and a panel showing a spinner needs to hear it.
    const seen: number[] = [];
    const stop = subscribePresets(() => seen.push(1));
    delete (globalThis as any).electronAPI;
    return loadPresets().then(() => {
      expect(seen).toHaveLength(1);
      stop();
    });
  });

  it("keeps notifying the others when one listener throws", () => {
    const seen: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stopA = subscribePresets(() => {
      throw new Error("bad subscriber");
    });
    const stopB = subscribePresets(() => seen.push("b"));

    installBridge([]);
    return loadPresets().then(() => {
      expect(seen).toEqual(["b"]);
      stopA();
      stopB();
    });
  });
});
