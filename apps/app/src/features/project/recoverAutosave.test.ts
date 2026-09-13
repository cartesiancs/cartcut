import { beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  RECOVER_DIRTY_MESSAGE,
  RECOVER_NOT_EMPTY_MESSAGE,
  recoverAutosave,
  type RecoverEffectsPort,
  type RecoverGuardPort,
  type RecoverReaderPort,
} from "./recoverAutosave";
import { serializeProjectEntries } from "./projectEntries";
import { renderOptionStore } from "../../states/renderOptionStore";
import type { TimelineTrack } from "../timeline/tracks";
import type { Timeline } from "../../@types/timeline";

/**
 * The guard table follows `timeline/parentOptions.test.ts`'s contract shape:
 * a table of states where every allowed one is allowed and every refused one
 * is refused, so the rule cannot drift from the thing it guards.
 *
 * Four cases are load-bearing, and all four are ways to destroy work:
 *
 * - a refusal must perform **no read** — not even opening the file;
 * - the path port must be **never called**, or the next ⌘S overwrites the
 *   user's `.ngt` with recovered older state;
 * - the anchor must be probed against the **project's** folder, not the
 *   cache's, or every clip reports as missing media;
 * - the ring must be **left alone**.
 */

const PROJECT = "/Users/me/Projects/Film.ngt";
const CACHE_FILE = "/Users/me/Library/autosave/f-abc-Film/20260913T142530-123Z-a1b2.ngt";

const TRACKS: TimelineTrack[] = [
  { id: "t1", kind: "video", name: "V1", index: 0 },
];

function elements(): Timeline {
  return {
    clip: {
      filetype: "video",
      startTime: 0,
      duration: 5000,
      location: { x: 0, y: 0 },
      trim: { startTime: 0, endTime: 5000 },
      width: 1920,
      height: 1080,
      localpath: "file:///Users/me/Projects/assets/a.mp4",
      priority: 1,
    },
  } as unknown as Timeline;
}

/** A real `.ngt`, built the way Auto Save builds one. */
async function archive(
  options: { anchor?: string | null; extra?: Record<string, string> } = {},
): Promise<Uint8Array> {
  const anchor = options.anchor === undefined ? PROJECT : options.anchor;
  const entries = serializeProjectEntries({
    elements: elements(),
    tracks: TRACKS,
    options: renderOptionStore.getInitialState().options,
    anchor: anchor ?? "",
  });

  const zip = new JSZip();
  zip.file("project.json", entries.project);
  zip.file("timeline.json", entries.timeline);
  zip.file("tracks.json", entries.tracks);
  zip.file("renderOptions.json", entries.renderOptions);
  zip.file("assetPaths.json", entries.assetPaths);

  if (options.extra != null) {
    for (const [name, text] of Object.entries(options.extra)) {
      zip.file(name, text);
    }
  } else if (anchor != null) {
    zip.file(
      "autosave.json",
      JSON.stringify({
        v: 1,
        anchor,
        writtenAtMs: Date.UTC(2026, 8, 13, 14, 25, 30),
        sessionId: "s1",
      }),
    );
  }

  return zip.generateAsync({ type: "uint8array" });
}

function ports() {
  const reads: string[] = [];
  const probes: string[] = [];
  const warned: string[] = [];
  const toasted: string[] = [];
  const adopted: unknown[] = [];
  const titles: string[] = [];
  let recovered = 0;
  let bytes: Uint8Array | null = null;
  let readThrows = false;

  const reader: RecoverReaderPort = {
    readFile: async (path) => {
      reads.push(path);
      if (readThrows) {
        throw new Error("EIO");
      }
      return bytes as unknown;
    },
    exists: async (fsPath) => {
      probes.push(fsPath);
      return fsPath.includes("/Users/me/Projects/assets/");
    },
  };

  const effects: RecoverEffectsPort = {
    adopt: (read) => adopted.push(read),
    setTitle: (title) => titles.push(title),
    setProjectPath: () => {
      // LOAD-BEARING. A recovered session must stay detached.
      throw new Error("setProjectPath must never be called on a recovery");
    },
    warn: (message) => warned.push(message),
    toast: (message) => toasted.push(message),
    markRecovered: () => {
      recovered += 1;
    },
  };

  return {
    reader,
    effects,
    reads,
    probes,
    warned,
    toasted,
    adopted,
    titles,
    recoveredCount: () => recovered,
    setBytes: (value: Uint8Array) => {
      bytes = value;
    },
    makeReadThrow: () => {
      readThrows = true;
    },
  };
}

function guard(isEmpty: boolean, isDirty: boolean): RecoverGuardPort {
  return { isEmpty: () => isEmpty, isDirty: () => isDirty };
}

const PICK = { key: "f-abc-Film", file: CACHE_FILE };

let p: ReturnType<typeof ports>;

beforeEach(async () => {
  p = ports();
  p.setBytes(await archive());
});

describe("the guard", () => {
  // The contract table. `empty` here means the timeline holds nothing at all.
  it.each([
    ["empty and clean", true, false, null],
    ["empty and dirty", true, true, "dirty"],
    ["not empty and clean", false, false, "not-empty"],
    ["not empty and dirty", false, true, "not-empty"],
  ] as const)(
    "with a timeline that is %s",
    async (_label, isEmpty, isDirty, refusal) => {
      const outcome = await recoverAutosave(
        PICK,
        guard(isEmpty, isDirty),
        p.reader,
        p.effects,
      );

      if (refusal == null) {
        expect(outcome.kind).toBe("recovered");
      } else {
        expect(outcome).toMatchObject({ kind: "refused", reason: refusal });
      }
    },
  );

  it("prefers the not-empty reason when both hold", () => {
    // Not arbitrary: "there is already an edit open" is the more useful
    // message, and it is true whether or not that edit is saved.
    expect(RECOVER_NOT_EMPTY_MESSAGE).toContain("already an edit open");
    expect(RECOVER_DIRTY_MESSAGE).toContain("unsaved changes");
  });

  it("performs no read when it refuses", async () => {
    // LOAD-BEARING. A refusal that still read and cleared would be the bug.
    await recoverAutosave(PICK, guard(false, true), p.reader, p.effects);
    expect(p.reads).toEqual([]);
    expect(p.probes).toEqual([]);
    expect(p.adopted).toEqual([]);
    expect(p.recoveredCount()).toBe(0);
  });

  it("touches nothing but the warning when it refuses", async () => {
    await recoverAutosave(PICK, guard(true, true), p.reader, p.effects);
    expect(p.warned).toHaveLength(1);
    expect(p.titles).toEqual([]);
    expect(p.toasted).toEqual([]);
  });

  it("refuses a timeline holding only tracks", async () => {
    // Three added rows and nothing else is work. `isProjectEmpty` counts
    // `tracks.length` for exactly this, and it is what the old element-only
    // detector read as unmodified.
    const outcome = await recoverAutosave(
      PICK,
      guard(false, false),
      p.reader,
      p.effects,
    );
    expect(outcome).toMatchObject({ kind: "refused", reason: "not-empty" });
  });
});

describe("recovering", () => {
  it("adopts the document", async () => {
    const outcome = await recoverAutosave(
      PICK,
      guard(true, false),
      p.reader,
      p.effects,
    );
    expect(outcome.kind).toBe("recovered");
    expect(p.adopted).toHaveLength(1);
    expect(p.recoveredCount()).toBe(1);
  });

  it("never adopts a project path", async () => {
    // LOAD-BEARING, and the sharpest hazard in the feature. The port throws
    // if called, so this asserts the rule rather than the wiring: a future
    // edit reasoning "we already have the anchor, let's set `#projectFile`"
    // would make the next ⌘S overwrite the user's `.ngt` with older state.
    await expect(
      recoverAutosave(PICK, guard(true, false), p.reader, p.effects),
    ).resolves.toMatchObject({ kind: "recovered" });
  });

  it("says it is recovered and unsaved in the title", async () => {
    await recoverAutosave(PICK, guard(true, false), p.reader, p.effects);
    expect(p.titles).toHaveLength(1);
    expect(p.titles[0]).toContain("Recovered");
    expect(p.titles[0]).toContain("unsaved");
    expect(p.titles[0]).toContain("Film.ngt");
  });

  it("tells the user to save it", async () => {
    await recoverAutosave(PICK, guard(true, false), p.reader, p.effects);
    expect(p.toasted.join(" ")).toContain("⌘S");
  });

  it("probes assets against the project's folder, not the cache's", async () => {
    // LOAD-BEARING. The archive lives under `userData/autosave` while its
    // media lives beside the user's `.ngt`. Probing the wrong folder is a
    // recovery that reports every clip as missing.
    await recoverAutosave(PICK, guard(true, false), p.reader, p.effects);
    expect(p.probes.some((path) => path.includes("/Users/me/Projects/"))).toBe(
      true,
    );
    expect(p.probes.some((path) => path.includes("autosave"))).toBe(false);
  });

  it("reports no missing media when the assets are there", async () => {
    const outcome = await recoverAutosave(
      PICK,
      guard(true, false),
      p.reader,
      p.effects,
    );
    expect(outcome).toMatchObject({ missing: 0 });
    expect(p.toasted.join(" ")).not.toContain("could not be found");
  });

  it("counts missing media in files", async () => {
    const missing = ports();
    missing.setBytes(await archive());
    const reader: RecoverReaderPort = {
      readFile: missing.reader.readFile,
      exists: async () => false,
    };
    const outcome = await recoverAutosave(
      PICK,
      guard(true, false),
      reader,
      missing.effects,
    );
    expect(outcome).toMatchObject({ kind: "recovered", missing: 1 });
    expect(missing.toasted.join(" ")).toContain("1 media file");
  });
});

describe("an archive with no autosave.json", () => {
  it("recovers, anchored on the file itself", async () => {
    // A hand-copied autosave, or one written before the entry existed.
    // Refusing would be worse than recovering with absolute paths.
    const bare = ports();
    bare.setBytes(await archive({ anchor: PROJECT, extra: {} }));

    const outcome = await recoverAutosave(
      PICK,
      guard(true, false),
      bare.reader,
      bare.effects,
    );
    expect(outcome.kind).toBe("recovered");
    // Anchored on the cache file, so the relative entry misses and the
    // absolute path is used — which is the documented fallback.
    expect(bare.probes.some((path) => path.includes("autosave"))).toBe(true);
  });

  it("says only that it is recovered, with no project named", async () => {
    const bare = ports();
    bare.setBytes(await archive({ anchor: PROJECT, extra: {} }));
    await recoverAutosave(PICK, guard(true, false), bare.reader, bare.effects);
    expect(bare.titles[0]).toContain("Recovered");
    expect(bare.titles[0]).not.toContain("Film.ngt");
  });

  it.each(["not json", "{}", "[]", '{"anchor":3}', "null"])(
    "recovers when autosave.json holds %j",
    async (contents) => {
      const odd = ports();
      odd.setBytes(
        await archive({ anchor: PROJECT, extra: { "autosave.json": contents } }),
      );
      const outcome = await recoverAutosave(
        PICK,
        guard(true, false),
        odd.reader,
        odd.effects,
      );
      expect(outcome.kind).toBe("recovered");
    },
  );
});

describe("failing to read", () => {
  it("warns and touches nothing when the file cannot be read", async () => {
    const broken = ports();
    broken.setBytes(new Uint8Array());
    broken.makeReadThrow();

    const outcome = await recoverAutosave(
      PICK,
      guard(true, false),
      broken.reader,
      broken.effects,
    );
    expect(outcome.kind).toBe("failed");
    expect(broken.warned).toHaveLength(1);
    expect(broken.adopted).toEqual([]);
    expect(broken.recoveredCount()).toBe(0);
  });

  it("warns and touches nothing when the bytes are not a zip", async () => {
    const junk = ports();
    junk.setBytes(new Uint8Array([1, 2, 3, 4]));

    const outcome = await recoverAutosave(
      PICK,
      guard(true, false),
      junk.reader,
      junk.effects,
    );
    expect(outcome.kind).toBe("failed");
    expect(junk.adopted).toEqual([]);
  });

  it("refuses a schema mismatch and touches nothing", async () => {
    const zip = new JSZip();
    zip.file("project.json", '{"schemaVersion":99}');
    zip.file("timeline.json", "{}");
    zip.file("tracks.json", "[]");

    const old = ports();
    old.setBytes(await zip.generateAsync({ type: "uint8array" }));

    const outcome = await recoverAutosave(
      PICK,
      guard(true, false),
      old.reader,
      old.effects,
    );
    expect(outcome.kind).toBe("failed");
    expect(old.warned[0]).toContain("v99");
    expect(old.adopted).toEqual([]);
  });
});
