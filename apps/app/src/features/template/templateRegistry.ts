/**
 * Which templates are installed, and what their documents are.
 *
 * Sits between `electron/lib/template.ts`, which knows where every installed
 * folder is, and `renderer/template.ts`, which needs a parsed document
 * synchronously inside the paint loop. Deliberately shaped like
 * `features/lut/lutRegistry.ts`, because it has the same three problems and
 * takes the same three answers.
 *
 * **Lazy.** The scanner reports a `template.ngt` as a *path* and never reads
 * it, the choice `presetScan.ts` makes for a `.cube` and for the same reason: a
 * library of thirty templates is tens of megabytes of media manifests, and a
 * project that uses none of them should parse none of them.
 *
 * **Synchronous reads, asynchronous loads.** `templateFor` is called from the
 * paint loop and cannot await; on a miss it starts the read and answers `null`,
 * which draws nothing for that frame. The preview repaints continuously so the
 * template appears on the next one — but an **export cannot rely on that**, and
 * `preloadTemplatesForDocument` is what its frame loop awaits first, exactly as
 * it awaits `preloadLutsForDocument`.
 *
 * **Failures are remembered and never retried.** A template that will not parse
 * must not cost a failed read on every frame of a four-thousand-frame render.
 * `templateFailures()` is what the panel reports.
 *
 * The contract every one of those adds up to, stated once: **a template that
 * is not installed draws nothing and reports nothing.** `null` covers not
 * installed, not read yet, still reading and unreadable alike, and the
 * difference matters to the panel rather than to the picture. It is what lets a
 * project that uses a template someone else has open, edit and save without
 * losing the template — the element keeps its `templateId`, its `fills` and its
 * `name`, and the picture comes back when the template does.
 */

import JSZip from "jszip";
import type { TemplateElementType, Timeline } from "../../@types/timeline";
import type { ExistsFn } from "../project/assetsFile";
import { parseTemplateManifest, type TemplateManifest } from "./archive";
import type { TemplateData } from "./compose";
import { readTemplateDocument, type NgtEntries } from "./templateDocument";

/** One installed template folder, as the main process reports it. */
export type InstalledTemplate = {
  id: string;
  origin: "builtin" | "user";
  /** The folder, absolute, POSIX-separated. */
  dir: string;
  /** Absolute path of `template.ngt` inside it. */
  ngtPath: string;
  /** Absolute path of the thumbnail, if the archive carried one. */
  thumbnailPath: string | null;
  /** Raw `template.json`, unparsed — main stays incurious, as it does for presets. */
  manifestJson: string | null;
};

/** What the panel shows for one row, without opening the document. */
export type TemplateListing = InstalledTemplate & {
  name: string;
  manifest: TemplateManifest;
};

type Entry =
  | { state: "loading" }
  | { state: "ready"; data: TemplateData }
  | { state: "failed"; message: string };

const entries = new Map<string, Entry>();
let library: TemplateListing[] = [];
const listeners = new Set<() => void>();

/** The last path segment of a folder — the fallback display name. */
function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? dir;
}

function announce(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Everything installed, built-ins first then user folders, each by name. */
export function installedTemplates(): TemplateListing[] {
  return library;
}

export function templateListing(id: string): TemplateListing | null {
  return library.find((entry) => entry.id === id) ?? null;
}

/**
 * Replace what the registry believes is installed.
 *
 * Anything whose folder is gone is forgotten, so re-importing a template makes
 * the next frame read the new file — the same reason `installLutResolver`
 * subscribes to the preset registry rather than caching for the session.
 */
export function setTemplateLibrary(next: readonly InstalledTemplate[]): void {
  library = next.map((entry) => {
    const manifest = parseTemplateManifest(safeParse(entry.manifestJson));
    return {
      ...entry,
      manifest,
      name: manifest.name ?? folderName(entry.dir),
    };
  });

  const live = new Set(library.map((entry) => entry.id));
  for (const id of [...entries.keys()]) {
    if (!live.has(id)) {
      entries.delete(id);
    }
  }
  announce();
}

/** Notified whenever the library changes. Returns its own unsubscribe. */
export function subscribeTemplates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The document for this template, or `null` if it is not ready.
 *
 * Safe to call from the paint loop: it never awaits and never throws.
 */
export function templateFor(templateId: string): TemplateData | null {
  const entry = entries.get(templateId);
  if (entry != null) {
    return entry.state === "ready" ? entry.data : null;
  }
  // Fire and forget. The next frame finds it.
  void loadTemplate(templateId);
  return null;
}

/** Read and parse one template, at most once. */
export async function loadTemplate(
  templateId: string,
): Promise<TemplateData | null> {
  const existing = entries.get(templateId);
  if (existing != null) {
    if (existing.state === "ready") {
      return existing.data;
    }
    if (existing.state === "failed") {
      return null;
    }
    return awaitEntry(templateId);
  }

  const listing = templateListing(templateId);
  if (listing == null) {
    entries.set(templateId, {
      state: "failed",
      message: "no template with that id is installed",
    });
    return null;
  }

  entries.set(templateId, { state: "loading" });
  try {
    const data = await reader(listing);
    entries.set(templateId, { state: "ready", data });
    return data;
  } catch (error) {
    entries.set(templateId, {
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Wait for a load already in flight.
 *
 * Polls the map on a timer rather than keeping a promise per id, the trade
 * `lutRegistry` makes for the same reason: loads finish in milliseconds and
 * only the preloader ever reaches this path.
 */
async function awaitEntry(templateId: string): Promise<TemplateData | null> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const entry = entries.get(templateId);
    if (entry == null || entry.state === "failed") {
      return null;
    }
    if (entry.state === "ready") {
      return entry.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

/** Every template id a document refers to. */
export function templateIdsIn(elements: Timeline): string[] {
  const ids = new Set<string>();
  for (const element of Object.values(elements)) {
    if (element?.filetype === "template") {
      const id = (element as TemplateElementType).templateId;
      if (typeof id === "string" && id !== "") {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/**
 * Read every template a document uses before anything draws it.
 *
 * The export's answer to lazy loading, and the contact sheet's. Failures are
 * swallowed: a template that will not parse draws nothing, which is what the
 * missing-template contract promises everywhere else.
 */
export async function preloadTemplatesForDocument(
  elements: Timeline,
): Promise<void> {
  await Promise.all(templateIdsIn(elements).map((id) => loadTemplate(id)));
}

/** Templates that are installed but could not be read, for the panel. */
export function templateFailures(): Array<{ id: string; message: string }> {
  const out: Array<{ id: string; message: string }> = [];
  for (const [id, entry] of entries) {
    if (entry.state === "failed" && templateListing(id) != null) {
      out.push({ id, message: entry.message });
    }
  }
  return out;
}

/** Test-only: forget every parsed document, and the library with it. */
export function resetTemplateRegistry(): void {
  entries.clear();
  library = [];
  listeners.clear();
  reader = defaultReader;
}

/** Test-only: put a document in directly, without touching the disk. */
export function setTemplateForTesting(id: string, data: TemplateData): void {
  entries.set(id, { state: "ready", data });
}

// ------------------------------------------------------------------- reading

export type TemplateReader = (
  listing: TemplateListing,
) => Promise<TemplateData>;

/**
 * How a listing becomes a document.
 *
 * Injectable so the suites can drive the state machine without a zip, a
 * filesystem or an Electron bridge — the same seam `renderer/surface.ts` opens
 * for its canvas factory, and for the same reason: the alternative is sniffing
 * for a global and testing code that does not ship.
 */
let reader: TemplateReader = defaultReader;

export function setTemplateReader(next: TemplateReader): TemplateReader {
  const previous = reader;
  reader = next;
  return previous;
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

type FilesystemBridge = {
  readFile?: (path: string) => Promise<unknown>;
  existFile?: (path: string) => Promise<unknown>;
};

/**
 * Reached through `globalThis`, not `window`.
 *
 * A bare `window` is a ReferenceError under `environment: "node"` and `window?.x`
 * does not save you — the same note `fx/presetRegistry.ts` carries.
 */
function filesystem(): FilesystemBridge | null {
  const api = (
    globalThis as {
      electronAPI?: { req?: { filesystem?: FilesystemBridge } };
    }
  )?.electronAPI?.req?.filesystem;
  return api ?? null;
}

const exists: ExistsFn = async (fsPath: string) => {
  const api = filesystem();
  if (api?.existFile == null) {
    return false;
  }
  try {
    return await api.existFile(fsPath);
  } catch {
    return false;
  }
};

/** The five entries of a `.ngt`, read with JSZip in the renderer. */
async function readNgt(ngtPath: string): Promise<NgtEntries> {
  const api = filesystem();
  if (api?.readFile == null) {
    throw new Error("no filesystem bridge is available");
  }
  const data = await api.readFile(ngtPath);
  if (data == null) {
    throw new Error("the template's template.ngt could not be read");
  }

  const zip = await JSZip.loadAsync(data as never);

  const text = async (name: string) => {
    const file = zip.file(name);
    return file == null ? null : await file.async("string");
  };

  return {
    project: await text("project.json"),
    timeline: await text("timeline.json"),
    tracks: await text("tracks.json"),
    renderOptions: await text("renderOptions.json"),
    assetPaths: await text("assetPaths.json"),
  };
}

async function defaultReader(listing: TemplateListing): Promise<TemplateData> {
  return readTemplateDocument(
    {
      id: listing.id,
      ngtPath: listing.ngtPath,
      manifest: listing.manifest,
      fallbackName: folderName(listing.dir),
      entries: await readNgt(listing.ngtPath),
    },
    exists,
  );
}

/** Ask the main process what is installed, and remember it. */
export async function refreshTemplateLibrary(): Promise<void> {
  const api = (
    globalThis as {
      electronAPI?: {
        req?: {
          template?: { list?: () => Promise<{ templates: InstalledTemplate[] }> };
        };
      };
    }
  )?.electronAPI?.req?.template;
  if (api?.list == null) {
    return;
  }
  try {
    const result = await api.list();
    setTemplateLibrary(result?.templates ?? []);
  } catch {
    // A library that cannot be listed is an empty one. Every template then
    // draws nothing, which is the contract rather than a new failure mode.
    setTemplateLibrary([]);
  }
}
