/**
 * What gets written down when something disagrees.
 *
 * A frame mismatch at frame 12,847 of an 18,000-frame export is not debuggable
 * from an assertion message. The rule here is that every failure leaves behind
 * enough to reach a diagnosis without re-running the export — which at the
 * `full` profile costs the better part of an hour.
 *
 * The heatmap is the piece worth explaining. A raw `|difference|` image is
 * unreadable, because a *correct* round trip reaches a maximum of 115 and the
 * eye cannot tell that from a real fault. So the difference is quantised
 * against the thresholds instead: codec noise comes out as faint blue tracing
 * the edges, and a genuine fault comes out as a solid red shape you recognise.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import type { FrameBuffer } from "./compare";
import type { Region } from "./paths";

// ------------------------------------------------------------- PNG encoding

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * Minimal RGBA PNG writer.
 *
 * Hand-rolled rather than pulled in as a dependency: the suite already carries
 * Playwright, and a PNG encoder is thirty lines of zlib plus a CRC. Adding a
 * package to the app's `devDependencies` so a test can save a debug image is a
 * poor trade.
 */
export function encodePng(frame: FrameBuffer): Buffer {
  const { width, height, data } = frame;
  const stride = width * 4;
  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer ?? data, (data as any).byteOffset ?? 0, data.length)
      .copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 6;   // colour type: RGBA
  header[10] = 0;  // deflate
  header[11] = 0;  // adaptive filtering
  header[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writePng(file: string, frame: FrameBuffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(frame));
}

// ------------------------------------------------------------- PNG decoding

/** Channels per pixel, by PNG colour type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Minimal PNG reader, for `page.screenshot()`.
 *
 * The mirror of `encodePng` above, and hand-rolled for the reason its comment
 * already gives: a PNG codec is zlib plus a CRC, and adding a package so a test
 * can look at a screenshot is a poor trade. `node:zlib` does the only hard part.
 *
 * It exists because **`getBoundingClientRect()` cannot see clipping**. An
 * element cut off by an ancestor's `overflow: hidden` reports exactly the rect
 * it would have had, so a layout assertion passes while the thing is invisible.
 * The only instrument that disagrees is the pixels, and until now the suite had
 * no way to read a DOM screenshot back: `decode.ts` is ffmpeg and video,
 * `reference.ts` goes through `getImageData` and so only works for a canvas.
 *
 * Deliberately narrow. Chromium writes 8-bit non-interlaced RGB or RGBA, so
 * that is what this reads, and anything else throws by name rather than
 * producing a plausible wrong picture. Palette and 16-bit would both need real
 * work and neither can arrive here.
 */
export function decodePng(png: Buffer): FrameBuffer {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (png[i] !== signature[i]) {
      throw new Error("decodePng: not a PNG");
    }
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat: Buffer[] = [];

  let at = 8;
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colourType = body[9];
      if (body[12] !== 0) {
        throw new Error("decodePng: interlaced PNGs are not supported");
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }

    // 4 length + 4 type + body + 4 CRC.
    at += 12 + length;
  }

  if (bitDepth !== 8) {
    throw new Error(`decodePng: bit depth ${bitDepth} is not supported, only 8`);
  }
  const channels = CHANNELS[colourType];
  if (channels == null || colourType === 0 || colourType === 4) {
    throw new Error(`decodePng: colour type ${colourType} is not supported, only 2 and 6`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  // The previous *unfiltered* scanline, which is what Up and Paeth refer to.
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    unfilter(line, previous, filter, channels);

    for (let x = 0; x < width; x++) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = line[from];
      out[to + 1] = line[from + 1];
      out[to + 2] = line[from + 2];
      out[to + 3] = channels === 4 ? line[from + 3] : 255;
    }

    previous = line;
  }

  return { data: out, width, height };
}

/** Undo one scanline's filter, in place. Spec section 9.2. */
function unfilter(line: Buffer, previous: Buffer, filter: number, bpp: number): void {
  const left = (i: number) => (i >= bpp ? line[i - bpp] : 0);
  const up = (i: number) => previous[i];
  const upLeft = (i: number) => (i >= bpp ? previous[i - bpp] : 0);

  for (let i = 0; i < line.length; i++) {
    switch (filter) {
      case 0:
        break;
      case 1:
        line[i] = (line[i] + left(i)) & 0xff;
        break;
      case 2:
        line[i] = (line[i] + up(i)) & 0xff;
        break;
      case 3:
        line[i] = (line[i] + ((left(i) + up(i)) >> 1)) & 0xff;
        break;
      case 4:
        line[i] = (line[i] + paeth(left(i), up(i), upLeft(i))) & 0xff;
        break;
      default:
        throw new Error(`decodePng: unknown filter ${filter}`);
    }
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------- heat map

/**
 * A difference image coloured by *threshold band*, not by magnitude.
 *
 *   <= 2   transparent   indistinguishable
 *   2-8    blue          ordinary codec noise
 *   8-24   yellow        worth a look
 *   > 24   red           the band `fracOver24` fails on
 */
export function heatmap(a: FrameBuffer, b: FrameBuffer): FrameBuffer {
  const { width, height } = a;
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(a.data[o] - b.data[o]),
      Math.abs(a.data[o + 1] - b.data[o + 1]),
      Math.abs(a.data[o + 2] - b.data[o + 2]),
    );
    if (d <= 2) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
    } else if (d <= 8) {
      out[o] = 40; out[o + 1] = 90; out[o + 2] = 255; out[o + 3] = 140;
    } else if (d <= 24) {
      out[o] = 255; out[o + 1] = 210; out[o + 2] = 40; out[o + 3] = 200;
    } else {
      out[o] = 255; out[o + 1] = 40; out[o + 2] = 40; out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

/** Reference, decoded and heatmap side by side, in that order. */
export function sideBySide(
  reference: FrameBuffer,
  decoded: FrameBuffer,
  diff: FrameBuffer,
  gap = 8,
): FrameBuffer {
  const width = reference.width * 3 + gap * 2;
  const height = reference.height;
  const out = Buffer.alloc(width * height * 4, 0);

  const blit = (src: FrameBuffer, offsetX: number) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < src.width; x++) {
        const from = (y * src.width + x) * 4;
        const to = (y * width + x + offsetX) * 4;
        // The heatmap is mostly transparent; composite it over black so the
        // saved image is readable in any viewer.
        const alpha = src.data[from + 3] / 255;
        out[to] = Math.round(src.data[from] * alpha);
        out[to + 1] = Math.round(src.data[from + 1] * alpha);
        out[to + 2] = Math.round(src.data[from + 2] * alpha);
        out[to + 3] = 255;
      }
    }
  };

  blit(reference, 0);
  blit(decoded, reference.width + gap);
  blit(diff, (reference.width + gap) * 2);
  return { data: out, width, height };
}

/** Crop a region out of a frame, for a focused artifact. */
export function crop(frame: FrameBuffer, region: Region): FrameBuffer {
  const out = Buffer.alloc(region.w * region.h * 4);
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      const from = ((region.y + y) * frame.width + region.x + x) * 4;
      const to = (y * region.w + x) * 4;
      out[to] = frame.data[from];
      out[to + 1] = frame.data[from + 1];
      out[to + 2] = frame.data[from + 2];
      out[to + 3] = frame.data[from + 3];
    }
  }
  return { data: out, width: region.w, height: region.h };
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
