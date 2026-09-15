/**
 * Naming a generated clip after everything that decides how it sounds.
 *
 * Its own file, with no Electron and no filesystem, so the rule can be checked:
 * a key that forgot one of its inputs would serve the wrong audio from the
 * cache, and that is a defect no amount of listening to the happy path finds.
 */

import { createHash } from "node:crypto";

import { ENGINE_VERSION, MODEL_REVISION } from "./ttsManifest";
import type { SynthesisRequest } from "./ttsProtocol";

/**
 * A stable file name for "this text, in this voice, at these settings".
 *
 * Hashed rather than spelled out because the text is the largest input and a
 * paragraph does not fit in a filename on any filesystem.
 *
 * The seed is deliberately **not** an input. It is derived *from* this key, so
 * the same request always starts from the same noise; folding it in as well
 * would be circular.
 */
export function speechKey(request: Omit<SynthesisRequest, "seed">): string {
  return createHash("sha1")
    .update(
      [
        MODEL_REVISION,
        ENGINE_VERSION,
        request.voice,
        request.lang,
        request.speed.toFixed(3),
        String(Math.round(request.steps)),
        request.text,
      ].join(" "),
    )
    .digest("hex")
    .slice(0, 24);
}

/**
 * The noise seed for a request, taken from its key.
 *
 * Means a cache hit and a fresh run produce the same audio, which is what lets
 * the cache be an optimisation rather than a behaviour change.
 */
export function seedFor(key: string): number {
  // The low 32 bits of the key's first eight hex digits. Any stable reduction
  // would do; this one is readable next to the filename it came from.
  return Number.parseInt(key.slice(0, 8), 16) >>> 0;
}
