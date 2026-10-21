import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { TemplateData } from "./compose";
import {
  exampleTemplateListing,
  exampleTemplateReader,
  openTemplateLink,
  templateSlugFrom,
  type TemplateHttpPort,
  type TemplateLinkPort,
} from "./templateLink";
import {
  ngtEntriesOf,
  type InstalledTemplate,
  type TemplateListing,
} from "./templateRegistry";
import { parseTemplateManifest } from "./archive";

describe("templateSlugFrom", () => {
  it("reads the slug a link names", () => {
    expect(templateSlugFrom("?template=launch-teaser")).toBe("launch-teaser");
    expect(templateSlugFrom("?a=1&template=Intro2")).toBe("intro2");
  });

  it("answers null when the link names none", () => {
    expect(templateSlugFrom("")).toBeNull();
    expect(templateSlugFrom("?templates=x")).toBeNull();
    expect(templateSlugFrom("?template=")).toBeNull();
  });

  it("refuses anything that could leave the examples folder", () => {
    for (const bad of [
      "../secret",
      "a/b",
      "%2e%2e",
      "a.b",
      "-lead",
      "trail-",
      "two--dashes",
      "x".repeat(65),
    ]) {
      expect(templateSlugFrom(`?template=${bad}`)).toBeNull();
    }
  });
});

describe("exampleTemplateListing", () => {
  it("points every path into the site's examples folder", () => {
    const listing = exampleTemplateListing(
      "teaser",
      JSON.stringify({ name: "Teaser", thumbnail: "thumbnail.png" }),
    );
    expect(listing).toMatchObject({
      id: "example:teaser",
      dir: "/examples/templates/teaser",
      ngtPath: "/examples/templates/teaser/template.ngt",
      thumbnailPath: "/examples/templates/teaser/thumbnail.png",
    });
  });
});

function listingOf(installed: InstalledTemplate): TemplateListing {
  const manifest = parseTemplateManifest(JSON.parse(installed.manifestJson!));
  return { ...installed, manifest, name: manifest.name ?? installed.id };
}

async function ngtBytes(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file("project.json", JSON.stringify({ schemaVersion: 2 }));
  zip.file(
    "timeline.json",
    JSON.stringify({
      clip: {
        filetype: "image",
        localpath: "/elsewhere/photo.jpg",
        startTime: 0,
        duration: 2000,
        location: { x: 0, y: 0 },
        width: 100,
        height: 100,
        opacity: 100,
        rotation: 0,
      },
    }),
  );
  zip.file("tracks.json", JSON.stringify([]));
  zip.file(
    "renderOptions.json",
    JSON.stringify({ previewSize: { w: 1280, h: 720 }, fps: 30 }),
  );
  zip.file(
    "assetPaths.json",
    JSON.stringify({
      version: 1,
      entries: {
        clip: {
          localpath: { abs: "/elsewhere/photo.jpg", rel: "media/photo.jpg" },
        },
      },
    }),
  );
  return zip.generateAsync({ type: "arraybuffer" });
}

describe("exampleTemplateReader", () => {
  it("fetches an example and relinks its media into the example's folder", async () => {
    const bytes = await ngtBytes();
    const fetched: string[] = [];
    const http: TemplateHttpPort = {
      text: async () => null,
      bytes: async (path) => {
        fetched.push(path);
        return bytes;
      },
      exists: async (path) => path === "/examples/templates/teaser/media/photo.jpg",
    };
    const reader = exampleTemplateReader(http, ngtEntriesOf, async () => {
      throw new Error("the fallback must not be reached");
    });

    const listing = listingOf(
      exampleTemplateListing("teaser", JSON.stringify({ name: "Teaser" })),
    );
    const data = await reader(listing);

    expect(fetched).toEqual(["/examples/templates/teaser/template.ngt"]);
    expect(data.name).toBe("Teaser");
    expect(data.size).toEqual({ w: 1280, h: 720 });
    expect(data.fps).toBe(30);
    expect(data.durationMs).toBe(2000);
    expect((data.elements.clip as { localpath: string }).localpath).toBe(
      "/examples/templates/teaser/media/photo.jpg",
    );
  });

  it("hands any other listing to the reader it wraps", async () => {
    const sentinel = { id: "user-one" } as TemplateData;
    const reader = exampleTemplateReader(
      {
        text: async () => null,
        bytes: async () => {
          throw new Error("must not fetch");
        },
        exists: async () => false,
      },
      ngtEntriesOf,
      async () => sentinel,
    );
    const listing = { id: "user-one" } as TemplateListing;
    expect(await reader(listing)).toBe(sentinel);
  });
});

function data(overrides: Partial<TemplateData> = {}): TemplateData {
  return {
    id: "example:teaser",
    name: "Teaser",
    size: { w: 1920, h: 1080 },
    durationMs: 30000,
    elements: {},
    slots: [],
    fps: 60,
    ...overrides,
  };
}

function port(overrides: Partial<TemplateLinkPort> = {}) {
  const calls: string[] = [];
  const base: TemplateLinkPort = {
    http: {
      text: async (path) => {
        calls.push(`text ${path}`);
        return JSON.stringify({ name: "Teaser" });
      },
    },
    register: (listing) => calls.push(`register ${listing.id}`),
    load: async (id) => {
      calls.push(`load ${id}`);
      return data();
    },
    applyFrame: (size, fps, durationMs) =>
      calls.push(`frame ${size.w}x${size.h}@${fps} ${durationMs}ms`),
    place: async (id) => {
      calls.push(`place ${id}`);
      return { ok: true, elementId: "el" };
    },
    select: (id) => calls.push(`select ${id}`),
  };
  return { calls, port: { ...base, ...overrides } };
}

describe("openTemplateLink", () => {
  it("registers, reads, matches the frame, then places and selects", async () => {
    const { calls, port: p } = port();
    const result = await openTemplateLink("teaser", p);
    expect(result).toEqual({
      ok: true,
      templateId: "example:teaser",
      elementId: "el",
      name: "Teaser",
    });
    expect(calls).toEqual([
      "text /examples/templates/teaser/template.json",
      "register example:teaser",
      "load example:teaser",
      "frame 1920x1080@60 30000ms",
      "place example:teaser",
      "select el",
    ]);
  });

  it("registers nothing for a folder the site does not serve", async () => {
    const { calls, port: p } = port({ http: { text: async () => null } });
    const result = await openTemplateLink("nope", p);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("treats a host's HTML fallback page as not found", async () => {
    const { calls, port: p } = port({
      http: { text: async () => "<!doctype html><html></html>" },
    });
    expect((await openTemplateLink("nope", p)).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("changes nothing in the project when the template cannot be read", async () => {
    const { calls, port: p } = port({ load: async () => null });
    const result = await openTemplateLink("teaser", p);
    expect(result.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("frame"))).toBe(false);
    expect(calls.some((c) => c.startsWith("place"))).toBe(false);
  });

  it("passes no rate on when the template names none", async () => {
    const { calls, port: p } = port({
      load: async () => data({ fps: undefined }),
    });
    await openTemplateLink("teaser", p);
    expect(calls).toContain("frame 1920x1080@null 30000ms");
  });

  it("reports a placement that declined, and selects nothing", async () => {
    const { calls, port: p } = port({
      place: async () => ({ ok: false, message: "no room" }),
    });
    expect(await openTemplateLink("teaser", p)).toEqual({
      ok: false,
      message: "no room",
    });
    expect(calls.some((c) => c.startsWith("select"))).toBe(false);
  });
});
