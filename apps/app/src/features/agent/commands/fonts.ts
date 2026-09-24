/**
 * Fonts as families rather than as files, and the weight row.
 *
 * **One font file is one face here.** `electron/lib/font.ts` walks the system
 * font directories and returns a flat list of files; `parseFontPath` makes the
 * filename stem the CSS family. So a machine with Aktiv Grotesk installed does
 * not have one font with six weights — it has eleven fonts called
 * `AktivGrotesk-Black`, `AktivGrotesk-Bold`, `AktivGrotesk-BoldItalic` and so
 * on, with nothing relating them.
 *
 * `font/fontWeight.ts` has related them since the weight row shipped, and the
 * agent surface never saw it: `list_fonts` answers files and `set_text_font`
 * writes three fields without the weight. That is the whole gap this file
 * closes, and it closes it by *calling* that module rather than by restating
 * any of it — the grouping, the nearest-rung fallback and the variable-font
 * rule all stay in one place.
 *
 * **Why these live in the renderer at all.** `electron/` cannot import
 * `apps/app/src` (`.tsconfig` pins `rootDir`), so main would need a second copy
 * of the filename parser. Two copies of a heuristic over foundry naming is
 * exactly the kind of thing that diverges quietly and is noticed as "the weight
 * row offers a rung the tool cannot select". The bridge exists for this.
 */

import type { TimelineElement } from "../../../@types/timeline";
import { setIn } from "../../../utils/immutable";
import { withFittedTextHeights } from "../../element/textFit";
import {
  DEFAULT_FONT,
  ensureFontFace,
  parseFontPath,
  type FontEntry,
} from "../../font/fontFaces";
import {
  DEFAULT_FONT_WEIGHT,
  elementFontWeight,
  faceFor,
  groupFontFamilies,
  labelForWeight,
  type FontFamily,
} from "../../font/fontWeight";
import { commit } from "../commit";
import { currentDoc, requireElement } from "../context";
import { registerCommands } from "../registry";

/** Most families one call reports. A machine can carry hundreds of files. */
const DEFAULT_FAMILY_LIMIT = 50;
const MAX_FAMILY_LIMIT = 200;

/**
 * The installed font files, from main.
 *
 * `window.electronAPI` is a `contextBridge` object, so this is the only way to
 * reach the list from here. It answers `{ status, fonts }` and a `status` of 0
 * means the walk failed; an empty list is the honest answer either way.
 */
async function installedFonts(): Promise<FontEntry[]> {
  const api = (globalThis as any).window?.electronAPI;
  const result = await api?.req?.font?.getLists?.();
  const fonts = result?.fonts;
  return Array.isArray(fonts) ? (fonts as FontEntry[]) : [];
}

/** Families whose name contains `query`, or all of them. */
function matching(families: FontFamily[], query: unknown): FontFamily[] {
  if (typeof query !== "string" || query === "") {
    return families;
  }
  const needle = query.toLowerCase();
  return families.filter((family) =>
    family.family.toLowerCase().includes(needle),
  );
}

/**
 * One family, as the agent sees it.
 *
 * `weights` is what the family actually ships — every rung for a variable
 * face, and only the rungs its upright faces provide for a static one. That
 * distinction is the point of the whole tool: asking a Regular-only family for
 * 600 does not give you Semibold, it gives you a synthesised fake bold.
 */
function familyRow(family: FontFamily) {
  const upright = family.faces.filter((face) => !face.italic);
  return {
    family: family.family,
    variable: family.variable,
    weights: family.weights,
    weightLabels: family.weights.map(labelForWeight),
    italic: family.faces.some((face) => face.italic),
    // The regular-weight file, so a caller that only wants the face can take
    // it straight to `set_text_font`'s `fontPath` without a second call.
    path: (faceFor(family, DEFAULT_FONT_WEIGHT, false) ??
      (upright[0] ?? family.faces[0]))?.entry?.path,
  };
}

/**
 * The face a request names, and why it might not be the one asked for.
 *
 * Returns the picked file plus the weight to *store*. The two are not the same
 * question, and conflating them is the bug `fontWeightToken` exists to
 * prevent: a static face already is its weight, so the number is a record of
 * which file was chosen, while a variable face is selected by the number at
 * draw time.
 */
function resolveFace(
  families: FontFamily[],
  familyName: string,
  weight: number,
  italic: boolean,
): { entry: FontEntry; weight: number; family: FontFamily } {
  const needle = familyName.toLowerCase();
  const family =
    families.find((one) => one.family.toLowerCase() === needle) ??
    families.find((one) => one.family.toLowerCase().includes(needle));

  if (family == null) {
    throw new Error(
      `No installed font family matches ${JSON.stringify(familyName)}. ` +
        `Use list_fonts with groupBy "family" to see what is available.`,
    );
  }

  const face = faceFor(family, weight, italic);
  if (face == null) {
    throw new Error(
      `"${family.family}" has no usable face. This is a font the system listed ` +
        `and could not be read.`,
    );
  }

  return { entry: face.entry, weight, family };
}

registerCommands({
  list_font_families: async (params: {
    query?: string;
    limit?: number;
    offset?: number;
  }) => {
    const families = groupFontFamilies(await installedFonts());
    const found = matching(families, params?.query);

    const offset = Math.max(0, Math.floor(params?.offset ?? 0));
    const limit = Math.min(
      MAX_FAMILY_LIMIT,
      Math.max(1, Math.floor(params?.limit ?? DEFAULT_FAMILY_LIMIT)),
    );
    const page = found.slice(offset, offset + limit);

    return {
      families: page.map(familyRow),
      total: found.length,
      offset,
      truncated: offset + page.length < found.length,
    };
  },

  set_text_font: async (params: {
    elementIds: string[];
    fontPath?: string;
    family?: string;
    weight?: number;
    italic?: boolean;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error("set_text_font needs at least one id in `elementIds`.");
    }

    const elements = ids.map((id) => requireElement(doc, id));
    const wrongType = elements.filter((element) => element.filetype !== "text");
    if (wrongType.length > 0) {
      throw new Error(
        `Only text clips have a font; got ${wrongType
          .map((element) => element.filetype)
          .join(", ")}.`,
      );
    }

    const wantsFamily = typeof params.family === "string" && params.family !== "";
    const hasPath = typeof params.fontPath === "string" && params.fontPath !== "";

    if (!wantsFamily && !hasPath && params.weight == null) {
      throw new Error(
        "set_text_font needs a `fontPath` from list_fonts, a `family`, or a `weight`.",
      );
    }

    /**
     * What each clip ends up with.
     *
     * Per clip rather than one answer for the batch, because a `weight` with no
     * `family` means "this clip's family, at that weight" — which is what the
     * weight row does, and a selection can hold several faces.
     */
    const picks = await resolvePicks(ids, elements, params, {
      wantsFamily,
      hasPath,
    });

    // Injected before the commit so the very next repaint can draw with it. A
    // canvas asked for a family it does not know falls back silently, and "the
    // tool said ok but the text looks the same" is the worst outcome here.
    for (const pick of picks) {
      ensureFontFace(pick.entry);
    }

    const result = commit((d) => {
      const elementMap = { ...d.elements };
      let changed = false;

      for (const pick of picks) {
        const before = elementMap[pick.id];
        let updated = before;
        updated = setIn(updated, ["fontpath"], pick.entry.path);
        updated = setIn(updated, ["fontname"], pick.entry.name);
        updated = setIn(updated, ["fonttype"], pick.entry.type);
        if (pick.weight != null) {
          updated = setIn(updated, ["fontweight"], pick.weight);
        }
        if (updated !== before) {
          elementMap[pick.id] = updated as TimelineElement;
          changed = true;
        }
      }

      // Identity, so `withCheckpoint` records no undo step for a font the clips
      // are already in. The old shape spread the document unconditionally and
      // so could never decline.
      if (!changed) {
        return d;
      }

      // A face with different metrics makes a different block. `update_clip`
      // folds this for every path that changes the layout; this one did not,
      // which left `height` stale until the next layout-affecting edit.
      return withFittedTextHeights({ ...d, elements: elementMap }, ids);
    }, "Those clips are already in that font.");

    return {
      ...result,
      fonts: picks.map((pick) => ({
        elementId: pick.id,
        family: pick.familyName,
        variable: pick.variable,
        weight: pick.weight,
        weightLabel: pick.weight == null ? null : labelForWeight(pick.weight),
        path: pick.entry.path,
      })),
    };
  },
});

/** What one clip's font is being set to. */
type Pick = {
  id: string;
  entry: FontEntry;
  /** `null` leaves `fontweight` alone — see below. */
  weight: number | null;
  familyName: string;
  variable: boolean;
};

/**
 * Turn the arguments into one pick per clip.
 *
 * The `fontPath`-only shape deliberately leaves `fontweight` alone. That is
 * what this tool has always done, and writing a weight derived from the
 * filename would be inventing authored intent for every existing prompt that
 * calls it — the same reason `normalizeFontWeight` reads every pre-existing
 * value as 400 rather than honouring the hard-coded `"medium"`.
 */
async function resolvePicks(
  ids: string[],
  elements: TimelineElement[],
  params: { fontPath?: string; family?: string; weight?: number; italic?: boolean },
  shape: { wantsFamily: boolean; hasPath: boolean },
): Promise<Pick[]> {
  if (!shape.wantsFamily && params.weight == null) {
    const entry = parseFontPath(params.fontPath as string);
    return ids.map((id) => ({
      id,
      entry,
      weight: null,
      familyName: entry.name,
      variable: false,
    }));
  }

  const families = groupFontFamilies(await installedFonts());
  const italic = params.italic === true;

  return ids.map((id, index) => {
    const element = elements[index] as any;
    const familyName = shape.wantsFamily
      ? (params.family as string)
      : String(element.fontname ?? DEFAULT_FONT.name);
    const weight =
      params.weight != null
        ? Math.round(params.weight)
        : elementFontWeight(element.fontname, element.fontweight);

    const found = resolveFace(families, familyName, weight, italic);
    return {
      id,
      entry: found.entry,
      weight,
      familyName: found.family.family,
      variable: found.family.variable,
    };
  });
}

/** Exported for the suite; nothing else should need them. */
export const __testing = { familyRow, matching, resolveFace };
