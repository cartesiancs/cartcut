/**
 * Font weight: what the ladder is, and how a font file's name says where on it
 * a face sits.
 *
 * The problem this solves is that **one font file is one face** here.
 * `electron/lib/font.ts` walks the system font directories and returns a flat
 * list of files, `parseFontPath` makes the filename stem the CSS family, and
 * the element stores that stem in `fontname`. So a machine with Aktiv Grotesk
 * installed does not have one font with six weights in the picker — it has
 * eleven fonts called `AktivGrotesk-Black`, `AktivGrotesk-Bold`,
 * `AktivGrotesk-BoldItalic` and so on, with nothing relating them.
 *
 * Grouping them back into a family and a weight is what makes a weight control
 * possible at all, and it has to be done from the filename because that is the
 * only thing the file list carries. Reading the actual `name` table out of the
 * font would be exact, but it means parsing 400 binaries at startup for a
 * dropdown.
 *
 * Kept DOM-free and dependency-free so it runs under `environment: "node"`,
 * and pure so the picker and the renderer cannot disagree about which file a
 * given weight means.
 */

import type { FontEntry } from "./fontFaces";

/** The CSS weight ladder, and what each rung is called in a font's filename. */
export const FONT_WEIGHTS = [
  { weight: 100, label: "Thin" },
  { weight: 200, label: "Extra Light" },
  { weight: 300, label: "Light" },
  { weight: 400, label: "Regular" },
  { weight: 500, label: "Medium" },
  { weight: 600, label: "Semi Bold" },
  { weight: 700, label: "Bold" },
  { weight: 800, label: "Extra Bold" },
  { weight: 900, label: "Black" },
] as const;

/** What the app assumes when nothing says otherwise. CSS `normal`. */
export const DEFAULT_FONT_WEIGHT = 400;

export function labelForWeight(weight: number): string {
  return (
    FONT_WEIGHTS.find((rung) => rung.weight === weight)?.label ?? String(weight)
  );
}

/**
 * Filename tokens that name a weight, lowercased and stripped of separators.
 *
 * Foundries disagree about nearly all of these — Adobe writes `Semibold`,
 * Google writes `SemiBold`, Monotype writes `Demi`, and `Hairline`, `Ultra`
 * and `Heavy` each mean something slightly different depending on who shipped
 * the file. They are matched against a key with `-`, `_` and spaces already
 * removed, so one entry covers every spelling of the separator.
 *
 * `Book` and `Roman` are 400 rather than a rung of their own: both are a
 * foundry's word for the upright text weight, and putting them anywhere else
 * would split a family in two.
 */
const WEIGHT_TOKENS: Record<string, number> = {
  hairline: 100,
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  book: 400,
  normal: 400,
  regular: 400,
  roman: 400,
  medium: 500,
  demi: 600,
  demibold: 600,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  xbold: 800,
  black: 900,
  heavy: 900,
  ultra: 900,
  ultrablack: 950,
};

/** Tokens that mean "slanted", in the same normalised form. */
const ITALIC_TOKENS = new Set(["italic", "oblique", "it"]);

/**
 * Tokens a variable font's filename uses for its axis list.
 *
 * A variable font is the one case where changing the weight does *not* change
 * the file: one binary covers the whole range, and the range has to reach CSS
 * as a `font-weight` descriptor or the browser will assume the file is a
 * single 400 face and synthesise everything else.
 */
const VARIABLE_TOKENS = new Set(["variable", "variablefont", "vf", "wght"]);

export type ParsedFace = {
  /** The family the face belongs to — the stem with its style tokens removed. */
  family: string;
  weight: number;
  italic: boolean;
  /** One file covering the whole ladder, rather than one rung of it. */
  variable: boolean;
};

/**
 * A variable font's axis suffix, run together with the family name.
 *
 * `PretendardVariable.ttf` is the shape Google and most foundries ship, and it
 * has no separator to split on. This is the one place the parser looks *inside*
 * a token, and it is safe only because no real family is named `…Variable`:
 * the general CamelCase split this would otherwise need is exactly what folds
 * `ArchivoBlack` into `Archivo` at weight 900.
 */
const RUN_ON_VARIABLE = /^(.+?)(variablefont|variable|vf)$/i;

/** `AktivGrotesk-BoldItalic` -> `["AktivGrotesk", "BoldItalic"]`. */
function splitStem(stem: string): string[] {
  const parts = (stem ?? "").split(/[-_\s]+/).filter((part) => part !== "");
  const last = parts[parts.length - 1];
  const runOn = last == null ? null : RUN_ON_VARIABLE.exec(last);

  if (runOn == null) {
    return parts;
  }

  return [...parts.slice(0, -1), runOn[1], runOn[2]];
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Peel one trailing token off the end of a face name.
 *
 * Returns what it recognised, or `null` — the caller stops at the first token
 * it does not understand, which is what keeps `Avenir Next Condensed` whole.
 * `Condensed` is a *width*, not a weight, and a family that lost it would be
 * merged with the family it was drawn to contrast against.
 */
function readStyleToken(
  token: string,
): { weight?: number; italic?: boolean; variable?: boolean } | null {
  const key = normalizeToken(token);
  if (key === "") {
    return null;
  }

  if (VARIABLE_TOKENS.has(key)) {
    return { variable: true };
  }
  if (ITALIC_TOKENS.has(key)) {
    return { italic: true };
  }
  if (WEIGHT_TOKENS[key] != null) {
    return { weight: WEIGHT_TOKENS[key] };
  }

  // `BoldItalic`, `SemiBoldItalic`, `LightOblique` — one token carrying both,
  // which is how most foundries name the file. Only a weight followed by a
  // slant is admitted, because that is the only order anyone writes.
  for (const slant of ITALIC_TOKENS) {
    if (key.endsWith(slant)) {
      const head = key.slice(0, -slant.length);
      if (WEIGHT_TOKENS[head] != null) {
        return { weight: WEIGHT_TOKENS[head], italic: true };
      }
    }
  }

  return null;
}

/**
 * Split a font file's stem into the family it belongs to and where on the
 * ladder it sits.
 *
 * Tokens are peeled from the **end**, and the first unrecognised one stops the
 * walk. That direction matters: `Archivo Black` and `Bebas Neue` are family
 * names in their own right, and a parser scanning the whole stem for a weight
 * word would fold `ArchivoBlack-Regular` into a family called `Archivo` at
 * weight 900 — a font that does not exist, under a name nobody typed.
 * `ArchivoBlack-Regular` peels `Regular`, hits `ArchivoBlack`, and stops.
 *
 * A stem that is *only* style tokens keeps the whole stem as the family: a
 * file called `Bold.ttf` is a font called Bold, not the bold weight of nothing.
 */
export function parseFaceName(stem: string): ParsedFace {
  const parts = splitStem(stem ?? "");

  if (parts.length === 0) {
    return {
      family: stem ?? "",
      weight: DEFAULT_FONT_WEIGHT,
      italic: false,
      variable: false,
    };
  }

  let weight: number | null = null;
  let italic = false;
  let variable = false;
  let end = parts.length;

  while (end > 1) {
    const parsed = readStyleToken(parts[end - 1]);
    if (parsed == null) {
      break;
    }
    // The *last* weight token wins, since the walk runs backwards and the one
    // nearest the family name is the one a two-word weight ended on.
    if (parsed.weight != null) {
      weight = parsed.weight;
    }
    italic = italic || parsed.italic === true;
    variable = variable || parsed.variable === true;
    end -= 1;
  }

  return {
    family: parts.slice(0, end).join(" "),
    // A variable file's name says nothing about which rung it starts on, and
    // it covers all of them anyway.
    weight: variable ? DEFAULT_FONT_WEIGHT : weight ?? DEFAULT_FONT_WEIGHT,
    italic,
    variable,
  };
}

// --------------------------------------------------------------- the grouping

export type FontFace = ParsedFace & { entry: FontEntry };

export type FontFamily = {
  /** Shown in the picker, and the only name the user ever sees. */
  family: string;
  faces: FontFace[];
  /** Every weight this family actually ships, ascending. */
  weights: number[];
  variable: boolean;
};

/**
 * Fold a flat list of font files into families.
 *
 * Families are keyed case-insensitively — `Helvetica` and `helvetica` are one
 * font with two files on a case-preserving filesystem — but the first spelling
 * seen is the one shown, so the list reads the way the foundry wrote it.
 */
export function groupFontFamilies(entries: FontEntry[]): FontFamily[] {
  const families = new Map<string, FontFamily>();

  for (const entry of entries ?? []) {
    if (entry == null || typeof entry.name !== "string" || entry.name === "") {
      continue;
    }

    const parsed = parseFaceName(entry.name);
    const key = parsed.family.toLowerCase();
    const existing = families.get(key);
    const face: FontFace = { ...parsed, entry };

    if (existing == null) {
      families.set(key, {
        family: parsed.family,
        faces: [face],
        weights: [],
        variable: parsed.variable,
      });
      continue;
    }

    existing.faces.push(face);
    existing.variable = existing.variable || parsed.variable;
  }

  const grouped = [...families.values()];

  for (const family of grouped) {
    // Upright faces only. A rung that exists solely as an italic is a rung the
    // weight row cannot deliver: `faceFor` is asked for an upright face, and
    // would answer with a *different* weight rather than a slanted one — so
    // offering it would be offering a choice that silently does nothing. A
    // family that is italic all the way through keeps its own weights, since
    // there is nothing else it could offer.
    const upright = family.faces.filter((face) => !face.italic);
    const shown = upright.length > 0 ? upright : family.faces;

    family.weights = family.variable
      ? FONT_WEIGHTS.map((rung) => rung.weight)
      : [...new Set(shown.map((face) => face.weight))].sort((a, b) => a - b);
  }

  grouped.sort((a, b) => a.family.localeCompare(b.family));
  return grouped;
}

/**
 * The face to draw for a requested weight, and whether a slanted one exists.
 *
 * The nearest-rung fallback is CSS's own rule, restated here because the app
 * has to *name a file* rather than hand the browser a family and let it
 * choose: `fontname` is one face, so picking the file is picking the weight.
 * Ties go to the heavier face, which is what stops a request for 500 on a
 * family that ships 400 and 600 from looking like it did nothing.
 *
 * A real slanted face is preferred over an upright one at the same weight, and
 * an upright one is taken when the family has no italics at all — the renderer
 * still applies its synthetic slant on top, exactly as it does today.
 */
export function faceFor(
  family: FontFamily | null | undefined,
  weight: number,
  italic = false,
): FontFace | null {
  const faces = family?.faces ?? [];
  if (faces.length === 0) {
    return null;
  }

  // One file covering the range: every weight is the same file.
  if (family?.variable === true) {
    const variable = faces.filter((face) => face.variable);
    return pickClosest(variable.length > 0 ? variable : faces, weight, italic);
  }

  return pickClosest(faces, weight, italic);
}

function pickClosest(
  faces: FontFace[],
  weight: number,
  italic: boolean,
): FontFace | null {
  let best: FontFace | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const face of faces) {
    // The slant is worth more than any distance on the ladder: a family's
    // 400 italic is a better answer for "bold italic" than its 700 upright,
    // because the renderer can thicken a face and cannot un-slant one.
    const slant = face.italic === italic ? 0 : 10_000;
    const distance = Math.abs(face.weight - weight);
    // Heavier wins a tie, hence the nudge rather than a plain distance.
    const score = slant + distance * 2 + (face.weight < weight ? 1 : 0);

    if (score < bestScore) {
      best = face;
      bestScore = score;
    }
  }

  return best;
}

// ------------------------------------------------------- reads and writes

/**
 * Read `element.fontweight` as a number on the ladder. Never throws.
 *
 * The guarding half of the `normalizeFps`/`coerceFps` split, and it runs on
 * every draw.
 *
 * **Every value written before this feature normalises to 400**, and that is
 * deliberate rather than lenient. `element/textElement.ts` hard-coded
 * `fontweight: "medium"` into every text clip the app has ever made and no
 * renderer ever read it, so the field carries no authored intent — honouring
 * it now as 500 would silently re-weight every caption in every existing
 * project on the first repaint after an update. A project written before this
 * renders byte-identically.
 */
export function normalizeFontWeight(value: unknown): number {
  const weight = typeof value === "number" ? value : Number(value);

  // `<= 0` and not merely non-finite: `Number("")`, `Number(null)` and
  // `Number("  ")` are all `0`, so an absent or emptied field would otherwise
  // clamp to a weight of 1 — a hairline — instead of reading as unset.
  if (!Number.isFinite(weight) || weight <= 0) {
    return DEFAULT_FONT_WEIGHT;
  }

  return clampWeight(Math.round(weight));
}

/**
 * Validate a weight on the way into the document, once, where it is stored.
 *
 * Snapped to the ladder rather than merely clamped: the picker only ever
 * offers rungs, and a `fontweight` of `437` is unrepresentable in the UI that
 * has to show it back.
 */
export function coerceFontWeight(value: unknown): number {
  const weight = normalizeFontWeight(value);

  // Annotated, or `as const` narrows it to the literal `100`.
  let nearest: number = FONT_WEIGHTS[0].weight;
  for (const rung of FONT_WEIGHTS) {
    if (Math.abs(rung.weight - weight) < Math.abs(nearest - weight)) {
      nearest = rung.weight;
    }
  }
  return nearest;
}

/** Only the upper end needs guarding; `normalizeFontWeight` handles the lower. */
function clampWeight(weight: number): number {
  return Math.min(1000, weight);
}

// ------------------------------------------------------- what the canvas gets

/**
 * The weight token for `ctx.font`, or `""` for none.
 *
 * **A static face already *is* its weight, and the number is a record of which
 * file was picked rather than a request to the canvas.** `AktivGrotesk-Bold`
 * is registered as its own CSS family with one face in it, so `faceFor` has
 * already chosen the weight by choosing the file; repeating the number can
 * only either say nothing or say something wrong. Measured in Chromium: asking
 * a Bold-only family for 700 or for 900 gives that face unchanged, but asking
 * a *Regular*-only family for 700 synthesises a bold over it and adds 17% ink.
 * The second is what a stale number would do — a weight left over from the
 * family before this one — and it would smear a face the user picked on
 * purpose.
 *
 * A variable face is the opposite case and the only one that needs the number:
 * one file covers the ladder and the number in `ctx.font` is what selects the
 * instance. Measured on `PretendardVariable`, that is nine distinct weights
 * from one file, 4,840 to 13,809 ink.
 *
 * The `bold` keyword is kept verbatim for a static face rather than written as
 * `700`. It is what this expression said before there was a weight row, so a
 * project written then renders byte-identically — which matters more than the
 * two being equivalent, because "equivalent" is a claim about a matcher rather
 * than about pixels.
 */
export function fontWeightToken(
  fontname: unknown,
  fontweight: unknown,
  isBold: boolean,
): string {
  const variable =
    typeof fontname === "string" && parseFaceName(fontname).variable;

  if (!variable) {
    return isBold ? "bold" : "";
  }

  // Bold raises the request rather than replacing it: on a variable face the
  // button and the weight row are two ways of asking for the same axis, and a
  // Black title should not get *lighter* because someone also pressed B.
  const weight = normalizeFontWeight(fontweight);
  return String(isBold ? Math.max(weight, 700) : weight);
}

/**
 * The weight a text element is actually *at*, whatever wrote it.
 *
 * `fontweight` is the authority when it holds a number, and the filename is
 * the fallback when it does not. That second half is what makes the panel
 * honest about a project written before this feature: every text clip the app
 * has ever made carries the hard-coded string `"medium"`, which names no
 * weight — but a clip set in `AktivGrotesk-Bold` plainly *is* bold, and a
 * weight row reading "Regular" over a bold caption would be reporting the
 * field rather than the picture.
 */
export function elementFontWeight(
  fontname: unknown,
  fontweight: unknown,
): number {
  const stored = typeof fontweight === "number" ? fontweight : Number(fontweight);

  if (Number.isFinite(stored) && stored > 0) {
    return normalizeFontWeight(stored);
  }

  return typeof fontname === "string"
    ? parseFaceName(fontname).weight
    : DEFAULT_FONT_WEIGHT;
}
