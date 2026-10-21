/**
 * Opening an example template from a link: `/?template=<slug>`.
 *
 * The browser build has no template folder to scan, so an example template is
 * a folder the site serves as static files, under
 * `/examples/templates/<slug>/`, laid out exactly as an extracted `.cttpl`:
 * `template.ngt` at its root, `template.json` beside it, the media wherever
 * `assetPaths.json` says. `scripts/buildWeb.mjs` copies `examples/templates/`
 * there, so a folder added to the repository is a link the next deploy serves.
 *
 * Opening one registers it with `templateRegistry` as an ordinary listing,
 * read by a reader that fetches instead of asking main, and places it on the
 * empty project at 0ms with the project's frame and rate set to the
 * template's, so the composite is the one the author rendered. Everything
 * with an effect is a port, so the sequence runs in the `node` suite.
 */

import type { NgtEntries } from "./templateDocument";
import { readTemplateDocument } from "./templateDocument";
import type { TemplateData } from "./compose";
import type {
  InstalledTemplate,
  TemplateListing,
  TemplateReader,
} from "./templateRegistry";
import { parseTemplateManifest } from "./archive";

export const TEMPLATE_LINK_PARAM = "template";

/** Where the site serves the example folders, from its root. */
export const EXAMPLE_TEMPLATE_ROOT = "/examples/templates";

const EXAMPLE_PREFIX = "example:";

/**
 * Lower-case words joined by single hyphens, at most 64 characters.
 *
 * The slug becomes part of a URL path, so anything that could climb out of
 * the examples folder (a dot, a slash, an encoded either) is refused rather
 * than cleaned up, for the reason `archive.ts` refuses an unsafe entry name.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The slug a page address asks for, or `null` when it asks for none. */
export function templateSlugFrom(search: string): string | null {
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(TEMPLATE_LINK_PARAM);
  } catch {
    return null;
  }
  if (raw == null) {
    return null;
  }
  const slug = raw.trim().toLowerCase();
  return slug.length <= 64 && SLUG.test(slug) ? slug : null;
}

export function exampleTemplateId(slug: string): string {
  return `${EXAMPLE_PREFIX}${slug}`;
}

export function isExampleTemplateId(id: string): boolean {
  return id.startsWith(EXAMPLE_PREFIX);
}

export function exampleTemplateDir(slug: string): string {
  return `${EXAMPLE_TEMPLATE_ROOT}/${slug}`;
}

/**
 * The listing the registry keeps for one example.
 *
 * `dir` and `ngtPath` are site paths rather than disk paths. That is enough:
 * `relinkAssets` resolves `assetPaths.json` against `ngtPath` with POSIX
 * arithmetic, and the demo build loads a `localpath` starting with `/` from
 * its own origin (`functions/mediaUrl.ts`).
 */
export function exampleTemplateListing(
  slug: string,
  manifestJson: string | null,
): InstalledTemplate {
  const dir = exampleTemplateDir(slug);
  const manifest = parseTemplateManifest(safeParse(manifestJson));
  return {
    id: exampleTemplateId(slug),
    origin: "builtin",
    dir,
    ngtPath: `${dir}/template.ngt`,
    thumbnailPath:
      manifest.thumbnail == null ? null : `${dir}/${manifest.thumbnail}`,
    manifestJson,
  };
}

function isJsonObject(raw: string): boolean {
  const value = safeParse(raw);
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function safeParse(raw: string | null): unknown {
  if (raw == null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The network, as the link needs it. */
export type TemplateHttpPort = {
  /** The body as text, or `null` for anything but a 2xx. */
  text(path: string): Promise<string | null>;
  /** The body as bytes, or `null` for anything but a 2xx. */
  bytes(path: string): Promise<ArrayBuffer | null>;
  /** Whether the site serves this path. Never throws. */
  exists(path: string): Promise<boolean>;
};

/**
 * A reader that fetches example templates and hands every other listing to
 * the one it wraps, so installing it costs the desktop paths nothing.
 */
export function exampleTemplateReader(
  http: TemplateHttpPort,
  unzip: (data: ArrayBuffer) => Promise<NgtEntries>,
  fallback: TemplateReader,
): TemplateReader {
  return async (listing: TemplateListing): Promise<TemplateData> => {
    if (!isExampleTemplateId(listing.id)) {
      return fallback(listing);
    }
    const data = await http.bytes(listing.ngtPath);
    if (data == null) {
      throw new Error("the template's template.ngt could not be fetched");
    }
    return readTemplateDocument(
      {
        id: listing.id,
        ngtPath: listing.ngtPath,
        manifest: listing.manifest,
        fallbackName: listing.dir.split("/").pop() ?? listing.id,
        entries: await unzip(data),
      },
      (path) => http.exists(path),
    );
  };
}

/** Everything opening a link touches, besides the network. */
export type TemplateLinkPort = {
  http: Pick<TemplateHttpPort, "text">;
  /** Adds the listing to whatever the registry already holds. */
  register(listing: InstalledTemplate): void;
  load(templateId: string): Promise<TemplateData | null>;
  /**
   * Sets the project's frame, rate and length, before anything is placed. The
   * length is the template's in ms; a project shorter than it would export
   * only its opening seconds.
   */
  applyFrame(
    size: { w: number; h: number },
    fps: number | null,
    durationMs: number,
  ): void;
  place(
    templateId: string,
  ): Promise<{ ok: true; elementId: string } | { ok: false; message: string }>;
  select(elementId: string): void;
};

export type TemplateLinkResult =
  | { ok: true; templateId: string; elementId: string; name: string }
  | { ok: false; message: string };

/**
 * Open one example: register it, read it, match the project to it, place it.
 *
 * A missing folder is reported rather than registered, so a mistyped link says
 * so instead of leaving a template on the timeline that draws nothing.
 */
export async function openTemplateLink(
  slug: string,
  port: TemplateLinkPort,
): Promise<TemplateLinkResult> {
  const dir = exampleTemplateDir(slug);
  const manifestJson = await port.http.text(`${dir}/template.json`);
  // A static host that answers every unknown path with the app's own page
  // returns 200 and HTML here, so "found" means "parsed as an object".
  if (manifestJson == null || !isJsonObject(manifestJson)) {
    return { ok: false, message: `There is no example template "${slug}".` };
  }

  const listing = exampleTemplateListing(slug, manifestJson);
  port.register(listing);

  const data = await port.load(listing.id);
  if (data == null) {
    return {
      ok: false,
      message: `The example template "${slug}" could not be read.`,
    };
  }

  port.applyFrame(data.size, data.fps ?? null, data.durationMs);

  const placed = await port.place(listing.id);
  if (!placed.ok) {
    return placed;
  }
  port.select(placed.elementId);
  return {
    ok: true,
    templateId: listing.id,
    elementId: placed.elementId,
    name: data.name,
  };
}
