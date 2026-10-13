/**
 * `compositions.json`: the templates a project owns, in its `.ngt`.
 *
 * A template expanded into the project (`composition/fork.ts`) is a timeline of
 * its own, and this is where it is saved. The entry follows the optional-entry
 * rule `extensions.json` and `timelineView.json` follow: absent when there is
 * nothing to hold, so a project nobody has expanded a template in is
 * byte-identical to one saved before the feature existed.
 *
 * What it does not follow is the rule that an optional entry never moves the
 * schema version. A build that predates this entry opens the project, draws
 * nothing for the clips that name a composition, and on its next save writes
 * the project without the entry it never read: the user's edited template is
 * gone for good, silently. So a project holding one is stamped
 * `COMPOSITION_SCHEMA_VERSION` and an older build refuses it, the judgement
 * `GRAPHIC_SCHEMA_VERSION` made for an older build that would have thrown.
 * Remove the last clip naming a composition and the project saves at its old
 * version again.
 *
 * Only the compositions main names are written (`project.ts#savedProject`):
 * the undo history can bring back a reference to one that is not named now,
 * and a reloaded project has no history.
 *
 * Each composition carries its own `assetPaths`, built and read by the very
 * functions main's `assetPaths.json` uses, so a project folder moved with its
 * media relinks its templates' media as it does its own.
 *
 * Pure apart from the injected `exists`, which is what `relinkAssets` probes
 * with.
 */

import type { Timeline } from "../../@types/timeline";
import type { Composition } from "../composition/project";
import type { TimelineTrack } from "../timeline/tracks";
import { relinkAssets, serializeAssetPaths, type ExistsFn } from "./assetsFile";

export const COMPOSITIONS_ENTRY = "compositions.json";

/** The entry's own format version, inside the file. */
const FORMAT = 1;

function sortedIds(compositions: Record<string, Composition>): string[] {
  return Object.keys(compositions).sort();
}

function described(composition: Composition) {
  return {
    id: composition.id,
    name: composition.name,
    size: { w: composition.size.w, h: composition.size.h },
    ...(composition.source == null ? {} : { source: composition.source }),
    tracks: composition.tracks,
    elements: composition.elements,
  };
}

/** The entry's text, or `null` when there is no composition to hold. */
export function serializeCompositions(
  compositions: Record<string, Composition>,
  anchor: string,
): string | null {
  const ids = sortedIds(compositions);
  if (ids.length === 0) {
    return null;
  }
  return JSON.stringify({
    v: FORMAT,
    compositions: ids.map((id) => ({
      ...described(compositions[id]),
      assetPaths: serializeAssetPaths(
        compositions[id].elements as Record<string, never>,
        anchor,
      ),
    })),
  });
}

/** `{ "compositions.json": text }`, or nothing, for `buildNgtBlob`'s extras. */
export function compositionsExtraEntries(
  compositions: Record<string, Composition>,
  anchor: string,
): Record<string, string> {
  const text = serializeCompositions(compositions, anchor);
  return text == null ? {} : { [COMPOSITIONS_ENTRY]: text };
}

/**
 * The compositions as the dirty digest sees them: no asset paths, which
 * depend on where the file is going rather than on what the project holds
 * (the reason `projectDigest.ts` leaves `assetPaths.json` out). `null` when
 * there are none, so a project without any digests as it always did.
 */
export function compositionsDigestText(
  compositions: Record<string, Composition>,
): string | null {
  const ids = sortedIds(compositions);
  if (ids.length === 0) {
    return null;
  }
  return JSON.stringify(ids.map((id) => described(compositions[id])));
}

function isSize(value: unknown): value is { w: number; h: number } {
  const size = value as { w?: unknown; h?: unknown } | null;
  return (
    size != null &&
    typeof size.w === "number" &&
    typeof size.h === "number" &&
    size.w > 0 &&
    size.h > 0
  );
}

export type ReadCompositionsResult = {
  compositions: Record<string, Composition>;
  relinked: number;
  /** Files not found, counted per composition. */
  missing: number;
};

/**
 * Read the entry back, each composition's media relinked against `anchor`.
 *
 * A guard, never a throw: a composition that is not well-formed is left out,
 * and the clips naming it draw nothing, the contract a template that is not
 * installed already has. An entry that is not there is no compositions.
 */
export async function readCompositions(
  text: string | null | undefined,
  anchor: string,
  exists: ExistsFn,
): Promise<ReadCompositionsResult> {
  const result: ReadCompositionsResult = {
    compositions: {},
    relinked: 0,
    missing: 0,
  };
  if (text == null || text === "") {
    return result;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return result;
  }
  const list = (raw as { compositions?: unknown } | null)?.compositions;
  if (!Array.isArray(list)) {
    return result;
  }

  for (const item of list) {
    const entry = item as Record<string, unknown> | null;
    if (entry == null || typeof entry !== "object") {
      continue;
    }
    const id = entry.id;
    const elements = entry.elements;
    if (
      typeof id !== "string" ||
      id === "" ||
      result.compositions[id] != null ||
      elements == null ||
      typeof elements !== "object" ||
      Array.isArray(elements) ||
      !isSize(entry.size)
    ) {
      continue;
    }
    const tracks = Array.isArray(entry.tracks)
      ? (entry.tracks as TimelineTrack[])
      : [];
    const relink = await relinkAssets(
      elements as Record<string, never>,
      entry.assetPaths,
      anchor,
      exists,
    );
    result.relinked += relink.relinked;
    result.missing += relink.missing;

    const source = entry.source as { templateId?: unknown; name?: unknown } | null;
    result.compositions[id] = {
      id,
      name: typeof entry.name === "string" ? entry.name : id,
      size: { w: (entry.size as any).w, h: (entry.size as any).h },
      ...(source != null &&
      typeof source.templateId === "string" &&
      typeof source.name === "string"
        ? { source: { templateId: source.templateId, name: source.name } }
        : {}),
      tracks,
      elements: relink.elements as Timeline,
    };
  }
  return result;
}
