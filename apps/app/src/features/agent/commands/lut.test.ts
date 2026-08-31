/**
 * `set_lut` from the agent surface.
 *
 * The claim pinned hardest here is the one every command family is held to:
 * **one instruction is one undo step, and a declined instruction costs
 * nothing.** Two more matter for this command specifically — that a LUT this
 * machine does not have is *stored* rather than refused, and that the caller is
 * told so.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useTimelineStore } from "../../../states/timelineStore";
import { __setPresetsForTesting } from "../../fx/presetRegistry";
import type { FxPreset } from "../../fx/presetTypes";
import {
  audioElement,
  effectElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../../renderer/testing";
import { lutOf } from "../../renderer/lut";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../../timeline/tracks";
import { getCommand } from "../registry";

import "./meta";
import "./lut";

async function run(name: string, params: any = {}) {
  const command = getCommand(name);
  if (command == null) {
    throw new Error(`no such command: ${name}`);
  }
  return (await command(params)) as any;
}

function doc() {
  return useTimelineStore.getState().getDocument();
}

function historyLength() {
  return useTimelineStore.getState().history.timelineHistory.length;
}

const KODAK = "com.cartcut.lut.print-2383";

function lutPreset(id: string): FxPreset {
  return {
    schema: 1,
    id,
    kind: "lut",
    name: id,
    category: "film",
    thumbnailPath: null,
    render: { type: "lut", source: "lut.cube" },
    params: [],
    origin: "builtin",
    sources: {},
    assets: { "lut.cube": "/nowhere/lut.cube" },
  };
}

function shaderPreset(id: string): FxPreset {
  return {
    ...lutPreset(id),
    kind: "effect",
    category: "color",
    render: { type: "shader", source: "shader.frag" },
  };
}

beforeEach(() => {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [
        createTrack("v1", "video", 0),
        createTrack("a1", "audio", 1),
        createTrack("e1", "effect", 2),
      ],
      elements: {
        clip: videoElement({ trackId: "v1", startTime: 0, duration: 4000 }),
        still: imageElement({ trackId: "v1", startTime: 4000, duration: 1000 }),
        box: shapeElement({ trackId: "v1", startTime: 5000, duration: 1000 }),
        title: textElement({ trackId: "v1", startTime: 6000, duration: 1000 }),
        sound: audioElement({ trackId: "a1", startTime: 0, duration: 4000 }),
        layer: effectElement({ trackId: "e1", startTime: 0, duration: 1000 }),
      },
    }),
  );
  __setPresetsForTesting([lutPreset(KODAK), shaderPreset("com.cartcut.bloom")]);
});

describe("set_lut", () => {
  it("grades one clip", async () => {
    const result = await run("set_lut", {
      elementIds: ["clip"],
      presetId: KODAK,
    });
    expect(result.ok).toBe(true);
    expect(lutOf(doc().elements.clip)).toEqual({
      presetId: KODAK,
      intensity: 100,
    });
  });

  it("takes an intensity", async () => {
    await run("set_lut", { elementIds: ["clip"], presetId: KODAK, intensity: 35 });
    expect(lutOf(doc().elements.clip)?.intensity).toBe(35);
  });

  it("grades every gradable filetype", async () => {
    await run("set_lut", {
      elementIds: ["clip", "still", "box", "title"],
      presetId: KODAK,
    });
    for (const id of ["clip", "still", "box", "title"]) {
      expect(lutOf(doc().elements[id])?.presetId, id).toBe(KODAK);
    }
  });

  // The whole justification for routing agent edits through `commit()`.
  //
  // Measured as undo *depth* rather than as a history count, because the first
  // agent edit in a freshly loaded document also lays down the baseline nothing
  // else records — see `features/agent/checkpoint.ts`, and the "known rough
  // edges" note in CLAUDE.md about the first edit after opening a project.
  it("costs one Cmd+Z for four clips", async () => {
    // Get the baseline out of the way, so what follows is the edit alone.
    await run("set_lut", { elementIds: ["clip"], presetId: KODAK });

    const before = historyLength();
    await run("set_lut", {
      elementIds: ["clip", "still", "box", "title"],
      presetId: KODAK,
    });
    expect(historyLength()).toBe(before + 1);

    await run("undo");
    for (const id of ["still", "box", "title"]) {
      expect(lutOf(doc().elements[id]), id).toBeNull();
    }
  });

  it("records nothing when the clips already have that LUT", async () => {
    await run("set_lut", { elementIds: ["clip"], presetId: KODAK });
    const before = historyLength();
    const result = await run("set_lut", { elementIds: ["clip"], presetId: KODAK });
    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  it("clears with a null presetId", async () => {
    await run("set_lut", { elementIds: ["clip"], presetId: KODAK });
    const result = await run("set_lut", { elementIds: ["clip"], presetId: null });
    expect(result.ok).toBe(true);
    expect(lutOf(doc().elements.clip)).toBeNull();
    expect("lut" in doc().elements.clip).toBe(false);
  });

  it("records nothing when clearing a clip that has no LUT", async () => {
    const before = historyLength();
    const result = await run("set_lut", { elementIds: ["clip"], presetId: null });
    expect(result.ok).toBe(false);
    expect(historyLength()).toBe(before);
  });

  it("undoes back to exactly where it started", async () => {
    const before = JSON.stringify(doc());
    await run("set_lut", { elementIds: ["clip", "still"], presetId: KODAK });
    expect(JSON.stringify(doc())).not.toBe(before);
    await run("undo");
    expect(JSON.stringify(doc())).toBe(before);
  });
});

describe("set_lut — refusals", () => {
  it("refuses an empty id list", async () => {
    await expect(run("set_lut", { elementIds: [], presetId: KODAK })).rejects.toThrow(
      /at least one id/,
    );
  });

  it("refuses an id that is not in the document", async () => {
    await expect(
      run("set_lut", { elementIds: ["nope"], presetId: KODAK }),
    ).rejects.toThrow();
  });

  it("names the offending filetypes rather than failing vaguely", async () => {
    await expect(
      run("set_lut", { elementIds: ["clip", "sound"], presetId: KODAK }),
    ).rejects.toThrow(/audio/);
  });

  // An adjustment layer carries its LUT as its own `presetId`; a `lut` field
  // on it would be a field nothing reads. The error says where to go instead.
  it("points an effect element at add_effect", async () => {
    await expect(
      run("set_lut", { elementIds: ["layer"], presetId: KODAK }),
    ).rejects.toThrow(/add_effect/);
  });

  it("refuses a preset that is not a LUT", async () => {
    await expect(
      run("set_lut", { elementIds: ["clip"], presetId: "com.cartcut.bloom" }),
    ).rejects.toThrow(/not a LUT/);
  });

  it("refuses a presetId that is neither a string nor null", async () => {
    await expect(
      run("set_lut", { elementIds: ["clip"], presetId: 7 }),
    ).rejects.toThrow(/list_luts/);
  });

  it("refuses a non-numeric intensity", async () => {
    await expect(
      run("set_lut", { elementIds: ["clip"], presetId: KODAK, intensity: "35" }),
    ).rejects.toThrow(/0 to 100/);
  });
});

describe("set_lut — a LUT this machine does not have", () => {
  // Refusing would mean an agent could not restore a grade from a project it
  // was handed. Storing it and saying so is what lets the grade come back
  // wherever the LUT is installed.
  it("stores the id anyway", async () => {
    const result = await run("set_lut", {
      elementIds: ["clip"],
      presetId: "com.somebody.lut.unknown",
    });
    expect(result.ok).toBe(true);
    expect(lutOf(doc().elements.clip)?.presetId).toBe("com.somebody.lut.unknown");
  });

  it("warns that it will render ungraded here", async () => {
    const result = await run("set_lut", {
      elementIds: ["clip"],
      presetId: "com.somebody.lut.unknown",
    });
    expect(result.warning).toMatch(/is installed here/);
    expect(result.warning).toMatch(/render ungraded/);
  });

  it("says nothing when the LUT is installed", async () => {
    const result = await run("set_lut", { elementIds: ["clip"], presetId: KODAK });
    expect(result.warning).toBeUndefined();
  });
});
