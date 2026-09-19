/**
 * Turning a subtitle file's bytes into text.
 *
 * `filesystem.readFile` answers with bytes, and a subtitle file's encoding is
 * not stated anywhere inside it. UTF-8 is the right first guess everywhere, and
 * the wrong one often enough in Korea that guessing it and stopping would be a
 * feature that garbles half the files it is given: `.srt` files circulated here
 * are routinely CP949, and a CP949 file decoded as UTF-8 does not fail, it
 * produces replacement characters.
 *
 * So UTF-8 is tried **strictly**, which is the whole trick. `fatal: true` makes
 * the decoder throw on a byte sequence UTF-8 cannot explain, and CP949 text is
 * full of those. Without `fatal` there is nothing to detect: the lossy decode
 * succeeds and hands back mojibake that looks exactly like a correctly-read file
 * of nonsense.
 *
 * The chosen encoding is reported rather than swallowed. When the result does
 * look like nonsense the user needs to be told which path produced it, or the
 * only available conclusion is that the importer is broken.
 */

export type SubtitleEncoding = "utf-8" | "cp949";

export type DecodedSubtitles = { text: string; encoding: SubtitleEncoding };

/**
 * Chromium's label for CP949. It is an alias of `euc-kr` in the WHATWG encoding
 * registry, and that registry's `euc-kr` decoder is CP949 (the extended one),
 * not the narrower original EUC-KR, which is what makes it the correct single
 * fallback for Korean files.
 */
const CP949 = "euc-kr";

export function decodeSubtitleBytes(bytes: Uint8Array): DecodedSubtitles {
  try {
    return {
      text: stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      encoding: "utf-8",
    };
  } catch {
    // Not UTF-8. Fall through.
  }

  try {
    return {
      text: stripBom(new TextDecoder(CP949).decode(bytes)),
      encoding: "cp949",
    };
  } catch {
    // A Node built against small ICU has no CP949 table, and constructing the
    // decoder is what throws. Electron always has it, so this is a developer's
    // machine running the suites: a lossy read with mangled glyphs is a better
    // answer than an import that refuses a file the app itself would accept.
    return {
      text: stripBom(new TextDecoder("utf-8").decode(bytes)),
      encoding: "utf-8",
    };
  }
}

/**
 * Whether this build can decode CP949 at all.
 *
 * Exported for the suite, which has to know whether it is asserting the fallback
 * or asserting that the fallback was unavailable. Nothing in the app calls it:
 * `decodeSubtitleBytes` already handles absence.
 */
export function hasCp949(): boolean {
  try {
    new TextDecoder(CP949);
    return true;
  } catch {
    return false;
  }
}

/** A BOM survives every decode and poisons whatever reads the first line. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
