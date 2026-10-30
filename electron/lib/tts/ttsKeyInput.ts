/**
 * What a speech key is computed from, and the seed taken from it.
 *
 * Its own file, with no Electron, no filesystem and no hashing, so the rule
 * can be checked and shared: a key that forgot one of its inputs would serve
 * the wrong audio from the cache, and that is a defect no amount of listening
 * to the happy path finds. The desktop hashes this string with `node:crypto`
 * (`ttsCacheKey.ts`), the browser build with SubtleCrypto; both use SHA-1 so
 * a request gets one key, and one starting noise, in either build.
 */

import { ENGINE_VERSION, MODEL_REVISION } from "./ttsManifest";
import type { SynthesisRequest } from "./ttsProtocol";

/** Hex digits kept from the digest. */
const KEY_LENGTH = 24;

/**
 * Every input that changes the sound, joined.
 *
 * The seed is deliberately **not** an input. It is derived *from* the key, so
 * the same request always starts from the same noise; folding it in as well
 * would be circular.
 */
export function speechKeyInput(request: Omit<SynthesisRequest, "seed">): string {
  return [
    MODEL_REVISION,
    ENGINE_VERSION,
    request.voice,
    request.lang,
    request.speed.toFixed(3),
    String(Math.round(request.steps)),
    request.text,
  ].join(" ");
}

/** The key from a SHA-1 of `speechKeyInput`, as lowercase hex. */
export function keyFromDigest(hex: string): string {
  return hex.toLowerCase().slice(0, KEY_LENGTH);
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
