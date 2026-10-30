/**
 * Naming a generated clip after everything that decides how it sounds.
 *
 * Desktop half: hashes with `node:crypto`. What is hashed, and the seed taken
 * from the result, live in `ttsKeyInput.ts`, which has no imports a browser
 * lacks, so the browser build hashes the same string with SubtleCrypto and
 * arrives at the same key, the same seed and therefore the same audio.
 */

import { createHash } from "node:crypto";

import { keyFromDigest, speechKeyInput } from "./ttsKeyInput";
import type { SynthesisRequest } from "./ttsProtocol";

export { seedFor } from "./ttsKeyInput";

/**
 * A stable file name for "this text, in this voice, at these settings".
 *
 * Hashed rather than spelled out because the text is the largest input and a
 * paragraph does not fit in a filename on any filesystem.
 */
export function speechKey(request: Omit<SynthesisRequest, "seed">): string {
  return keyFromDigest(
    createHash("sha1").update(speechKeyInput(request)).digest("hex"),
  );
}
