import { afterEach, describe, expect, it, vi } from "vitest";
import type { Timeline } from "../../@types/timeline";
import { imageElement } from "../renderer/testing";
import { createTemplateElement } from "../timeline/templateOps";
import type { TemplateData } from "./compose";
import {
  installedTemplates,
  loadTemplate,
  preloadTemplatesForDocument,
  resetTemplateRegistry,
  setTemplateLibrary,
  setTemplateReader,
  subscribeTemplates,
  templateFailures,
  templateFor,
  templateIdsIn,
  templateListing,
  type InstalledTemplate,
} from "./templateRegistry";

/**
 * The registry's whole contract in one line: **a template that is not
 * installed draws nothing and reports nothing.** `templateFor` is called from
 * the paint loop, so every path through it has to answer without awaiting and
 * without throwing — and a failure has to be remembered, or a broken template
 * costs a failed read on every frame of a render.
 */

function listing(over: Partial<InstalledTemplate> = {}): InstalledTemplate {
  return {
    id: "neon",
    origin: "user",
    dir: "/Users/me/Library/templates/neon",
    ngtPath: "/Users/me/Library/templates/neon/template.ngt",
    thumbnailPath: null,
    manifestJson: null,
    ...over,
  };
}

function data(over: Partial<TemplateData> = {}): TemplateData {
  return {
    id: "neon",
    name: "Neon",
    size: { w: 100, h: 100 },
    durationMs: 2000,
    elements: { a: imageElement({ key: "a" }) } as Timeline,
    slots: [],
    ...over,
  };
}

function placed(templateId: string) {
  return {
    ...createTemplateElement({
      templateId,
      name: "T",
      durationMs: 1000,
      size: { w: 10, h: 10 },
      frame: { w: 10, h: 10 },
    }),
  };
}

afterEach(() => {
  resetTemplateRegistry();
});

describe("the library", () => {
  it("reports what was set, with a name from the manifest", () => {
    setTemplateLibrary([
      listing({ manifestJson: JSON.stringify({ name: "Neon Intro" }) }),
    ]);
    expect(installedTemplates()[0].name).toBe("Neon Intro");
  });

  it("falls back to the folder name", () => {
    setTemplateLibrary([listing()]);
    expect(installedTemplates()[0].name).toBe("neon");
  });

  it("survives an unreadable manifest", () => {
    setTemplateLibrary([listing({ manifestJson: "{ not json" })]);
    expect(installedTemplates()[0].name).toBe("neon");
  });

  it("forgets a parsed document when its folder is gone", async () => {
    // Re-importing a template has to make the next frame read the new file.
    setTemplateReader(async () => data());
    setTemplateLibrary([listing()]);
    await loadTemplate("neon");
    expect(templateFor("neon")).not.toBeNull();

    setTemplateLibrary([]);
    expect(templateFor("neon")).toBeNull();
  });

  it("notifies subscribers, and stops when unsubscribed", () => {
    const seen = vi.fn();
    const off = subscribeTemplates(seen);
    setTemplateLibrary([listing()]);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    setTemplateLibrary([]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("answers null for a listing that is not there", () => {
    expect(templateListing("ghost")).toBeNull();
  });
});

describe("templateFor", () => {
  it("answers null on a miss and does not throw", () => {
    setTemplateLibrary([]);
    expect(templateFor("ghost")).toBeNull();
  });

  it("answers the document once it has loaded", async () => {
    setTemplateReader(async () => data());
    setTemplateLibrary([listing()]);
    await loadTemplate("neon");
    expect(templateFor("neon")?.name).toBe("Neon");
  });

  it("answers null while a load is still in flight", async () => {
    let release: (value: TemplateData) => void = () => {};
    setTemplateReader(() => new Promise((resolve) => (release = resolve)));
    setTemplateLibrary([listing()]);

    const inFlight = loadTemplate("neon");
    expect(templateFor("neon")).toBeNull();
    release(data());
    await inFlight;
    expect(templateFor("neon")).not.toBeNull();
  });
});

describe("failures", () => {
  it("are remembered and never retried", async () => {
    // The reason this matters: a render is thousands of frames, and each one
    // asks. One read, one message, and then nothing.
    const read = vi.fn(async () => {
      throw new Error("the template's timeline.json is missing");
    });
    setTemplateReader(read);
    setTemplateLibrary([listing()]);

    expect(await loadTemplate("neon")).toBeNull();
    expect(await loadTemplate("neon")).toBeNull();
    templateFor("neon");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("are reported with their message", async () => {
    setTemplateReader(async () => {
      throw new Error("written by a different version");
    });
    setTemplateLibrary([listing()]);
    await loadTemplate("neon");
    expect(templateFailures()).toEqual([
      { id: "neon", message: "written by a different version" },
    ]);
  });

  it("do not report a template that is no longer installed", async () => {
    setTemplateReader(async () => {
      throw new Error("nope");
    });
    setTemplateLibrary([listing()]);
    await loadTemplate("neon");
    setTemplateLibrary([]);
    expect(templateFailures()).toEqual([]);
  });

  it("records a miss without a reader ever being called", async () => {
    const read = vi.fn(async () => data());
    setTemplateReader(read);
    setTemplateLibrary([]);
    expect(await loadTemplate("ghost")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("templateIdsIn", () => {
  it("finds every template a document places", () => {
    const elements = {
      a: placed("neon"),
      b: placed("retro"),
      c: imageElement(),
    } as unknown as Timeline;
    expect(templateIdsIn(elements).sort()).toEqual(["neon", "retro"]);
  });

  it("reports one id once, however many times it is placed", () => {
    const elements = {
      a: placed("neon"),
      b: placed("neon"),
    } as unknown as Timeline;
    expect(templateIdsIn(elements)).toEqual(["neon"]);
  });

  it("ignores an element with no usable id", () => {
    const elements = {
      a: { ...placed("neon"), templateId: "" },
    } as unknown as Timeline;
    expect(templateIdsIn(elements)).toEqual([]);
  });
});

describe("preloadTemplatesForDocument", () => {
  it("reads every template before it resolves", async () => {
    // What an export awaits. Its frame loop runs to completion in one go, so a
    // document arriving on frame three would leave frames one and two empty.
    setTemplateReader(async (entry) => data({ id: entry.id }));
    setTemplateLibrary([
      listing({ id: "neon" }),
      listing({ id: "retro", dir: "/x/retro" }),
    ]);

    await preloadTemplatesForDocument({
      a: placed("neon"),
      b: placed("retro"),
    } as unknown as Timeline);

    expect(templateFor("neon")).not.toBeNull();
    expect(templateFor("retro")).not.toBeNull();
  });

  it("resolves even when every template is missing", async () => {
    setTemplateLibrary([]);
    await expect(
      preloadTemplatesForDocument({ a: placed("ghost") } as unknown as Timeline),
    ).resolves.toBeUndefined();
  });
});
