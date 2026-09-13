/**
 * Bytes to base64, for handing a built archive across IPC.
 *
 * `filesystem.writeFileEnsured` takes base64 because the renderer cannot put a
 * `Buffer` on the wire, so every module that assembles a zip needs this — and
 * there were two copies, one of them slow enough to matter.
 *
 * **The chunking is the whole point.** The naive form appends one character per
 * byte (`binary += String.fromCharCode(bytes[i])`), which is what
 * `functions/project.ts` did: a fresh rope node per byte, tens of millions of
 * them for a real project, blocking the thread that draws the preview. Taking
 * 0x8000 bytes at a time through `String.fromCharCode(...)` is the same answer
 * in a fraction of the time.
 *
 * 0x8000 rather than the whole array because the spread becomes arguments on
 * the stack, and a few hundred thousand of those is a `RangeError`.
 */

/** The number of bytes spread into one `String.fromCharCode` call. */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}
