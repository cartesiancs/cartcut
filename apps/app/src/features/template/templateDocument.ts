/**
 * Turning an installed `template.ngt` into the `TemplateData` the renderer uses.
 *
 * A `.cttpl` holds a real `.ngt`, so this reads one the same way
 * `functions/project.ts#load` does — and reuses the same
 * `features/project/assetsFile.ts#relinkAssets` to resolve the relative paths
 * inside it against the folder it was extracted into. That reuse is the whole
 * reason the format needed almost no new path code: a template folder and a
 * portable project folder are the same problem, and it was already solved.
 *
 * Everything with an effect on disk is a parameter — the JSON entries arrive as
 * strings and `exists` is injected — so this runs in the `node` suite and the
 * registry above it is left holding nothing but IO and a state machine.
 *
 * **The version gate is a compatibility check, not a migrator**, exactly as it
 * is for a project: a `template.ngt` from a different `SCHEMA_VERSION` is
 * refused with a message rather than guessed at. What it is *not* is a reason
 * to refuse the archive at install time — a template that cannot be read is a
 * template that draws nothing, which is the contract the registry states.
 */

import type { Timeline } from "../../@types/timeline";
import type { ExistsFn } from "../project/assetsFile";
import { relinkAssets } from "../project/assetsFile";
import { spanEnd } from "../timeline/geometry";
import {
  normalizeDocument,
  SCHEMA_VERSION,
  type TimelineTrack,
} from "../timeline/tracks";
import type { TemplateManifest } from "./archive";
import type { TemplateData } from "./compose";
import { slotsOf } from "./slots";

/** The five entries of a `.ngt`, as text. `null` for one the archive lacks. */
export type NgtEntries = {
  project: string | null;
  timeline: string | null;
  tracks: string | null;
  renderOptions: string | null;
  assetPaths: string | null;
};

export type ReadTemplateInput = {
  id: string;
  /** Absolute path of the extracted `template.ngt`, for relinking. */
  ngtPath: string;
  manifest: TemplateManifest;
  /** Used when the manifest names nothing — normally the installed folder. */
  fallbackName: string;
  entries: NgtEntries;
};

/** Default frame, for a template whose render options say nothing usable. */
const FALLBACK_SIZE = { w: 1920, h: 1080 };

function parse(raw: string | null): unknown {
  if (raw == null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * How long the template runs.
 *
 * The extent of its **content**, not `renderOptions.videoDuration`. That field
 * is a project setting the author may never have tightened, and a template
 * whose bar ran ten seconds while its picture stopped at six would look broken
 * in a way nothing on screen explained. The setting is the fallback for a
 * template with no elements at all, which is a template of nothing.
 */
export function templateDurationOf(
  elements: Timeline,
  renderOptions: unknown,
): number {
  let end = 0;
  for (const element of Object.values(elements)) {
    if (element == null || typeof element !== "object") {
      continue;
    }
    end = Math.max(end, spanEnd(element));
  }
  if (end > 0) {
    return end;
  }
  const seconds = positive(
    (renderOptions as { videoDuration?: unknown })?.videoDuration,
  );
  return seconds == null ? 0 : seconds * 1000;
}

/** The size the template's document was composed at. */
export function templateSizeOf(renderOptions: unknown): {
  w: number;
  h: number;
} {
  const raw = (renderOptions as { previewSize?: unknown })?.previewSize;
  const w = positive((raw as { w?: unknown })?.w);
  const h = positive((raw as { h?: unknown })?.h);
  return w == null || h == null ? { ...FALLBACK_SIZE } : { w, h };
}

/**
 * Read one installed template.
 *
 * Throws with a message the panel can show. The registry records that message
 * once and never retries, so a broken template costs one read rather than one
 * per frame.
 */
export async function readTemplateDocument(
  input: ReadTemplateInput,
  exists: ExistsFn,
): Promise<TemplateData> {
  const project = parse(input.entries.project) as {
    schemaVersion?: unknown;
  } | null;

  // Absent means a `.ngt` written before `project.json` existed, which is
  // version 1 — the same reading `functions/project.ts` takes.
  const schemaVersion = project?.schemaVersion ?? 1;
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `the template was written by a different version of Cartcut (${String(
        schemaVersion,
      )} rather than ${SCHEMA_VERSION})`,
    );
  }

  const rawElements = parse(input.entries.timeline);
  if (rawElements == null || typeof rawElements !== "object") {
    throw new Error("the template's timeline.json is missing or unreadable");
  }

  const rawTracks = parse(input.entries.tracks);
  const tracks = (Array.isArray(rawTracks) ? rawTracks : []) as TimelineTrack[];
  const renderOptions = parse(input.entries.renderOptions);

  // The same order `project.ts#load` uses, and for the same reason: relink
  // before anything reads a path, so nothing ever sees the author's machine.
  const relinked = await relinkAssets(
    rawElements as Record<string, never>,
    parse(input.entries.assetPaths),
    input.ngtPath,
    exists,
  );

  // Through `normalizeDocument` so `priority` is the one the compositor would
  // see and the parent graph is repaired. A hand-built map would let a template
  // render here and not in the app.
  const document = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks,
    elements: relinked.elements as Timeline,
  });

  return {
    id: input.id,
    name: input.manifest.name ?? input.fallbackName,
    size: templateSizeOf(renderOptions),
    durationMs: templateDurationOf(document.elements, renderOptions),
    elements: document.elements,
    // Derived once here rather than on every read, which is what lets
    // `composeTemplate` treat the slot list as a lookup.
    slots: slotsOf(document.elements),
  };
}
