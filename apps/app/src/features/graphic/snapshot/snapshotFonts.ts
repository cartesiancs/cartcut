/**
 * The `@font-face` rules a graphic's SVG snapshot carries.
 *
 * An SVG image loads nothing, so every web font the graphic's text computes
 * goes in as a `data:` URL. The faces are the page's own: every same-origin
 * `@font-face` the document has (the default face in `style.css`, the
 * vendored "Noto Sans KR" slices, and the faces `fontFaces.ts#ensureFontFace`
 * writes for parameters), read from the stylesheets so a face is found the
 * same way whoever declared it. Each keeps every descriptor it was declared
 * with (a variable face without its weight range would turn bold into faux
 * bold), and only the ones whose `unicode-range` the text reaches are carried.
 *
 * What travels is decided in `font/fontPlan.ts` and cut in `font/fontSubset.ts`.
 * Bytes, subsets and finished rules are cached as promises, so the faces of a
 * playing graphic are made once and frames only reuse strings.
 */

import postcss, { type AtRule, type Declaration } from "postcss";
import {
  base64Of,
  embedPlan,
  familyNames,
  fontKind,
  parseFontSrc,
  parseUnicodeRange,
  rangeHits,
  type FontSource,
} from "../../font/fontPlan";
import { loadSubsetter, type Subsetter } from "../../font/fontSubset";

let wasmUrl: string | null = null;
let subsetter: Promise<Subsetter | null> | null = null;

/**
 * Where `harfbuzz-subset.wasm` is served from. Set at boot by the browser
 * builds (`index.ts`); without it a large face travels whole.
 */
export function installSubsetWasmUrl(url: string): void {
  wasmUrl = url;
}

function theSubsetter(): Promise<Subsetter | null> {
  if (subsetter == null) {
    subsetter =
      wasmUrl == null
        ? Promise.resolve(null)
        : loadSubsetter(wasmUrl).catch((error) => {
            console.warn("graphic: font subsetting is unavailable, faces travel whole", error);
            return null;
          });
  }
  return subsetter;
}

type FaceRule = {
  /** The first family name, unquoted and lowercased. */
  family: string;
  descriptors: Array<[string, string]>;
  sources: FontSource[];
  base: string;
  ranges: Array<[number, number]>;
};

let facesSignature = "";
let faces: FaceRule[] = [];

function sheetRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try {
    return sheet.cssRules;
  } catch {
    // Another origin's sheet: not readable, and not ours to carry.
    return null;
  }
}

function collectFaces(rules: CSSRuleList, base: string, out: FaceRule[]): void {
  for (const rule of Array.from(rules)) {
    const inner = (rule as CSSGroupingRule).cssRules;
    if (inner != null && rule.constructor?.name !== "CSSFontFaceRule") {
      collectFaces(inner, base, out);
      continue;
    }
    if (!/^@font-face/i.test(rule.cssText)) {
      continue;
    }
    let at: AtRule | undefined;
    try {
      at = postcss.parse(rule.cssText).first as AtRule | undefined;
    } catch {
      continue;
    }
    if (at == null || at.type !== "atrule") {
      continue;
    }
    const descriptors: Array<[string, string]> = [];
    let family = "";
    let src = "";
    let range: string | null = null;
    at.walkDecls((decl: Declaration) => {
      const prop = decl.prop.toLowerCase();
      if (prop === "src") {
        src = decl.value;
        return;
      }
      if (prop === "font-family") {
        family = decl.value;
      }
      if (prop === "unicode-range") {
        range = decl.value;
      }
      descriptors.push([prop, decl.value]);
    });
    const name = familyNames(family)[0];
    if (name == null || src === "") {
      continue;
    }
    out.push({
      family: name,
      descriptors,
      sources: parseFontSrc(src),
      base,
      ranges: parseUnicodeRange(range),
    });
  }
}

/** Every same-origin `@font-face` in the document, re-read when a sheet changes. */
function documentFaces(): FaceRule[] {
  const sheets = Array.from(document.styleSheets);
  const signature = sheets
    .map((sheet) => `${sheet.href ?? "inline"}:${sheetRules(sheet)?.length ?? -1}`)
    .join("|");
  if (signature === facesSignature) {
    return faces;
  }
  const out: FaceRule[] = [];
  for (const sheet of sheets) {
    const rules = sheetRules(sheet);
    if (rules != null) {
      collectFaces(rules, sheet.href ?? document.baseURI, out);
    }
  }
  facesSignature = signature;
  faces = out;
  return out;
}

const bytes = new Map<string, Promise<Uint8Array | null>>();
const embedded = new Map<string, Promise<string | null>>();

function fetchBytes(url: string): Promise<Uint8Array | null> {
  let hit = bytes.get(url);
  if (hit == null) {
    hit = fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : null))
      .then((buffer) => (buffer == null ? null : new Uint8Array(buffer)))
      .catch(() => null);
    bytes.set(url, hit);
  }
  return hit;
}

/** One face's `src` value, carried: `url(data:...) format(...)`, or `null`. */
function embedFace(url: string, codepoints: readonly number[]): Promise<string | null> {
  const key = url + "|" + codepoints.join(",");
  let hit = embedded.get(key);
  if (hit == null) {
    hit = (async () => {
      const full = await fetchBytes(url);
      if (full == null) {
        return null;
      }
      let carried = full;
      const plan = embedPlan(full);
      if (plan.kind === "subset") {
        const subset = await theSubsetter();
        const cut = subset?.(full, codepoints, { retainGids: plan.retainGids }) ?? null;
        if (cut != null) {
          carried = cut;
        }
      }
      const kind = fontKind(carried);
      return `url("data:${kind.mime};base64,${base64Of(carried)}") format("${kind.format}")`;
    })();
    embedded.set(key, hit);
  }
  return hit;
}

/**
 * `@font-face` rules carrying every web face `fontFamilies` names, cut to
 * `codepoints`. A face no source of which can be fetched is left out, which
 * draws it in the next family on the list, as a page whose font failed would.
 */
export async function fontFaceCss(
  fontFamilies: readonly string[],
  codepoints: readonly number[],
): Promise<string> {
  const wanted = new Set<string>();
  for (const list of fontFamilies) {
    for (const name of familyNames(list)) {
      wanted.add(name);
    }
  }
  if (wanted.size === 0) {
    return "";
  }
  const rules = await Promise.all(
    documentFaces()
      .filter((face) => wanted.has(face.family) && rangeHits(face.ranges, codepoints))
      .map(async (face) => {
        const used =
          face.ranges.length === 0
            ? codepoints
            : codepoints.filter((cp) => face.ranges.some(([from, to]) => cp >= from && cp <= to));
        const sources: string[] = [];
        for (const source of face.sources) {
          if ("local" in source) {
            sources.push(`local("${source.local.replace(/"/g, '\\"')}")`);
            continue;
          }
          let absolute: string;
          try {
            absolute = new URL(source.url, face.base).href;
          } catch {
            continue;
          }
          const carried = await embedFace(absolute, used);
          if (carried != null) {
            sources.push(carried);
            break;
          }
        }
        if (sources.length === 0) {
          return "";
        }
        const descriptors = face.descriptors.map(([prop, value]) => `${prop}:${value};`).join("");
        return `@font-face{${descriptors}src:${sources.join(",")};}`;
      }),
  );
  return rules.filter((rule) => rule !== "").join("\n");
}
