import { describe, expect, it } from "vitest";
import { arrayBufferToBase64, bytesToBase64 } from "./base64";

/**
 * The chunk boundary is the only interesting thing here, so most of these sit
 * either side of it. A correct implementation and the slow one it replaced
 * agree on every input; what a wrong *chunking* produces is a truncated or
 * transposed archive, which JSZip reports as a corrupt file long after the
 * write reported success.
 */

const CHUNK = 0x8000;

/** Node's own answer, as the oracle. `btoa` is what the module uses. */
function reference(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function ramp(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = i % 256;
  }
  return bytes;
}

describe("bytesToBase64", () => {
  it("encodes an empty array as an empty string", () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });

  it.each([1, 2, 3, 4, 255])("agrees with Buffer at %i bytes", (length) => {
    const bytes = ramp(length);
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
  });

  // The padding cases: base64 groups by three, so a length of 3n+1 and 3n+2
  // end in "==" and "=" respectively. A chunk size not divisible by 3 would
  // pad in the *middle* of the output, which is the classic way to get this
  // wrong while every small test still passes.
  it.each([
    CHUNK - 1,
    CHUNK,
    CHUNK + 1,
    CHUNK + 2,
    CHUNK * 2,
    CHUNK * 2 + 1,
    CHUNK * 3 - 1,
  ])("agrees with Buffer across the chunk boundary at %i bytes", (length) => {
    const bytes = ramp(length);
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
  });

  it.each([CHUNK * 2, CHUNK * 2 + 1, CHUNK * 2 + 2])(
    "pads only at the very end at %i bytes",
    (length) => {
      // CHUNK is 32768, which is not a multiple of 3. An implementation that
      // encoded each chunk separately and concatenated would emit "=" at every
      // chunk boundary — and would still pass every equal-length comparison
      // below 32768 bytes, which is why this is asserted on its own.
      expect(bytesToBase64(ramp(length))).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    },
  );

  it("encodes every byte value", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
  });

  it("reads only the view, not the whole backing buffer", () => {
    // `subarray` shares the buffer, so an implementation reaching for
    // `bytes.buffer` instead of the view would encode the neighbours too.
    const backing = ramp(64);
    const view = backing.subarray(16, 32);
    expect(bytesToBase64(view)).toBe(reference(view));
  });

  it("survives a payload larger than the argument limit", () => {
    // The reason for chunking at all: spreading this many arguments in one
    // call is a RangeError.
    const bytes = ramp(600_000);
    expect(bytesToBase64(bytes)).toBe(reference(bytes));
  });
});

describe("arrayBufferToBase64", () => {
  it("agrees with the byte form", () => {
    const bytes = ramp(CHUNK + 7);
    expect(arrayBufferToBase64(bytes.buffer as ArrayBuffer)).toBe(
      bytesToBase64(bytes),
    );
  });
});
