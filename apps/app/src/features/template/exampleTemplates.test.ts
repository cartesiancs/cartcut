import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import type { Timeline } from "../../@types/timeline";
import { assetFieldsOf, graphicAssetRefsOf } from "../project/assetsFile";
import { hashProgram } from "../fx/programHash";
import { toRawPayload } from "../fx/inlineProgram";
import { validatePreset } from "../fx/presetValidate";
import { parseTemplateManifest } from "./archive";
import { readTemplateDocument, type NgtEntries } from "./templateDocument";
import { exampleTemplateDir, templateSlugFrom } from "./templateLink";

// The folders the web build serves at `/?template=<slug>`
// (`scripts/buildWeb.mjs`), read the way the browser reads them. Nothing else
// checks one before it is deployed, and a path that only resolves on its
// author's machine fails silently there: the clip draws nothing.

const repo = path.resolve(__dirname, "../../../../..");
const examplesDir = path.join(repo, "examples/templates");
const slugs = fs.existsSync(examplesDir)
  ? fs.readdirSync(examplesDir).filter((name) => fs.statSync(path.join(examplesDir, name)).isDirectory())
  : [];

/** Cloudflare Pages refuses a file over 25 MiB, and the whole deploy with it. */
const PAGES_FILE_LIMIT = 25 * 1024 * 1024;

/** A path that names a place on somebody's machine rather than on the site. */
const MACHINE_PATH = /\/Users\/|\/home\/|[A-Za-z]:\\\\|file:\/\//;

/** A site path, as the browser would fetch it, on disk in this checkout. */
const onDisk = (sitePath: string) => path.join(repo, decodeURI(sitePath));

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

async function entriesOf(slug: string): Promise<NgtEntries> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(examplesDir, slug, "template.ngt")));
  const text = async (name: string) => (await zip.file(name)?.async("string")) ?? null;
  return {
    project: await text("project.json"),
    timeline: await text("timeline.json"),
    tracks: await text("tracks.json"),
    renderOptions: await text("renderOptions.json"),
    assetPaths: await text("assetPaths.json"),
  };
}

function pathsOf(elements: Timeline): string[] {
  const out: string[] = [];
  for (const element of Object.values(elements)) {
    for (const field of assetFieldsOf(element)) {
      const value = (element as Record<string, unknown>)[field];
      if (typeof value === "string" && value !== "" && !/^(https?|blob|data):/i.test(value)) out.push(value);
    }
    for (const ref of graphicAssetRefsOf(element)) out.push(ref.value);
  }
  return out;
}

describe("example templates", () => {
  it("finds the folders", () => {
    expect(slugs.length).toBeGreaterThan(0);
  });

  describe.each(slugs)("%s", (slug) => {
    const dir = exampleTemplateDir(slug);

    it("is a name a link can ask for", () => {
      expect(templateSlugFrom(`?template=${slug}`)).toBe(slug);
    });

    it("has a manifest naming it, and the thumbnail it names", () => {
      const manifest = parseTemplateManifest(
        JSON.parse(fs.readFileSync(path.join(examplesDir, slug, "template.json"), "utf8")),
      );
      expect(manifest.name).toBeTruthy();
      expect(manifest.thumbnail).toBeTruthy();
      expect(fs.existsSync(path.join(examplesDir, slug, manifest.thumbnail!))).toBe(true);
    });

    // The cloud server refuses a template folder whose manifest has no
    // numeric `schema`, and the app hides one whose `schema` it cannot read,
    // so a stale value either drops the template or offers one that fails.
    it("declares the schema its document is written at", async () => {
      const manifest = JSON.parse(fs.readFileSync(path.join(examplesDir, slug, "template.json"), "utf8"));
      const project = JSON.parse((await entriesOf(slug)).project ?? "{}");
      expect(typeof manifest.schema).toBe("number");
      expect(manifest.schema).toBe(project.schemaVersion);
    });

    it("carries no path from its author's machine", async () => {
      for (const [name, text] of Object.entries(await entriesOf(slug))) {
        expect(text ?? "", name).not.toMatch(MACHINE_PATH);
      }
    });

    it("finds every file it names inside its own folder", async () => {
      const looked: string[] = [];
      const data = await readTemplateDocument(
        {
          id: `example:${slug}`,
          ngtPath: `${dir}/template.ngt`,
          manifest: { name: null, author: null, thumbnail: null },
          fallbackName: slug,
          entries: await entriesOf(slug),
        },
        async (sitePath) => {
          looked.push(sitePath);
          return fs.existsSync(onDisk(sitePath));
        },
      );

      const paths = pathsOf(data.elements);
      expect(paths.length).toBeGreaterThan(0);
      for (const sitePath of paths) {
        expect(sitePath.startsWith(`${dir}/`), sitePath).toBe(true);
        expect(fs.existsSync(onDisk(sitePath)), sitePath).toBe(true);
      }
      // The harness asked the disk, so a pass is not a probe that answered
      // yes to everything.
      expect(looked.length).toBeGreaterThan(0);
      expect(fs.existsSync(onDisk(`${dir}/no-such-file.mp4`))).toBe(false);
    });

    it("offers slots, and every program it carries validates and is named by its content", async () => {
      const elements = JSON.parse((await entriesOf(slug)).timeline!) as Timeline;
      expect(Object.values(elements).some((element) => (element as any).replaceable != null)).toBe(true);

      for (const element of Object.values(elements) as any[]) {
        if (element.program == null) continue;
        const { hash: _hash, ...content } = element.program;
        expect(element.presetId).toBe(`inline.${hashProgram(content)}`);
        const result = validatePreset(toRawPayload(element.program));
        expect(result.ok, `${element.name}: ${JSON.stringify((result as any).errors)}`).toBe(true);
      }
    });

    it("fits Cloudflare Pages' per-file limit", () => {
      for (const file of filesUnder(path.join(examplesDir, slug))) {
        expect(fs.statSync(file).size, path.relative(repo, file)).toBeLessThanOrEqual(PAGES_FILE_LIMIT);
      }
    });
  });
});
