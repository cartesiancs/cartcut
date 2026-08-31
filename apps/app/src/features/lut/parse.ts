/**
 * One door for every LUT format.
 *
 * Callers — the registry, the import flow, the generator's own round-trip
 * check — hand this bytes and a filename and get a `LutData` or a
 * `LutParseError` that says which line was wrong. Nothing else in the app
 * knows that more than one format exists.
 *
 * **The extension is a hint, not the answer.** LUTs are renamed constantly:
 * `.cube` files arrive as `.CUBE`, `.txt` and `.lut`, and a `.3dl` that
 * someone converted keeps its old name. So the extension picks the *first*
 * reader to try and the content decides. A file that is plainly a `.cube` —
 * it says `LUT_3D_SIZE` — is read as one whatever it is called.
 *
 * When both readers fail, the error reported is the one from the format the
 * file *looked* most like, not whichever ran last: telling someone their
 * `.cube` "has no mesh line" because the `.3dl` reader spoke second would send
 * them looking in the wrong place.
 */

import { parseCube } from "./cube";
import { parseImageLut, type ImagePixels } from "./haldImage";
import { type LutData, LutParseError } from "./lutData";
import { parse3dl } from "./lut3dl";

/** What the file picker offers and the drop target accepts. */
export const LUT_TEXT_EXTENSIONS = ["cube", "3dl"] as const;
export const LUT_IMAGE_EXTENSIONS = ["png"] as const;
export const LUT_FILE_EXTENSIONS = [
  ...LUT_TEXT_EXTENSIONS,
  ...LUT_IMAGE_EXTENSIONS,
] as const;

export type LutTextFormat = "cube" | "3dl";

/** Lowercased extension without the dot, or `""`. */
export function extensionOf(filename: string): string {
  const at = filename.lastIndexOf(".");
  return at === -1 ? "" : filename.slice(at + 1).toLowerCase();
}

export function isLutFilename(filename: string): boolean {
  return (LUT_FILE_EXTENSIONS as readonly string[]).includes(
    extensionOf(filename),
  );
}

export function isImageLutFilename(filename: string): boolean {
  return (LUT_IMAGE_EXTENSIONS as readonly string[]).includes(
    extensionOf(filename),
  );
}

/**
 * Which text reader the content asks for.
 *
 * A `.cube` announces itself with a size keyword, which no `.3dl` contains, so
 * the test is exact in that direction. Absent one, `3DMESH` or a first
 * data-bearing line with more than three numbers — the mesh — says `.3dl`.
 * Everything else falls back to `.cube`, which produces the more useful error
 * for a file that is not a LUT at all.
 */
export function sniffLutFormat(text: string): LutTextFormat {
  const head = text.slice(0, 64 * 1024).toUpperCase();
  if (head.includes("LUT_3D_SIZE") || head.includes("LUT_1D_SIZE")) {
    return "cube";
  }
  if (head.includes("3DMESH") || head.includes("MESH ")) {
    return "3dl";
  }
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = raw.split("#")[0].trim();
    if (line === "") {
      continue;
    }
    const parts = line.split(/[\s,]+/);
    if (!/^[+-]?\d/.test(parts[0])) {
      continue;
    }
    return parts.length === 3 ? "cube" : "3dl";
  }
  return "cube";
}

export function parseLutText(text: string, filename = ""): LutData {
  const extension = extensionOf(filename);
  const preferred: LutTextFormat =
    extension === "3dl" || extension === "cube"
      ? (extension as LutTextFormat)
      : sniffLutFormat(text);
  // The extension is only a hint; content that is unmistakably one format wins
  // over a name that says the other.
  const sniffed = sniffLutFormat(text);
  const first = sniffed !== preferred && isDecisive(text) ? sniffed : preferred;
  const second: LutTextFormat = first === "cube" ? "3dl" : "cube";

  try {
    return read(text, first);
  } catch (firstError) {
    try {
      return read(text, second);
    } catch {
      // Report the failure of the reader the file looked most like.
      throw firstError;
    }
  }
}

/** Whether the content names its own format rather than merely resembling one. */
function isDecisive(text: string): boolean {
  const head = text.slice(0, 64 * 1024).toUpperCase();
  return (
    head.includes("LUT_3D_SIZE") ||
    head.includes("LUT_1D_SIZE") ||
    head.includes("3DMESH")
  );
}

function read(text: string, format: LutTextFormat): LutData {
  return format === "cube" ? parseCube(text) : parse3dl(text);
}

export type LutSource =
  | { kind: "text"; text: string; filename?: string }
  | { kind: "image"; image: ImagePixels };

export function parseLut(source: LutSource): LutData {
  if (source.kind === "image") {
    return parseImageLut(source.image);
  }
  return parseLutText(source.text, source.filename ?? "");
}

/** Turn any thrown value into the message the import toast shows. */
export function describeLutError(error: unknown): string {
  if (error instanceof LutParseError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
