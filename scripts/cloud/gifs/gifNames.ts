/**
 * What the GIF fetchers share: downloads, Unicode's emoji keywords, and the
 * rule that turns words into a file name.
 *
 * A cloud GIF is one file whose name is its tags, split on `_`
 * (`server/src/gifs.rs`), so naming is the whole of describing one.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A name's length in UTF-8 bytes, before `.gif`. File systems allow 255, and
 * the install path on Windows has to fit in 260 characters with the user's
 * profile folder in front of it.
 */
export const MAX_NAME_BYTES = 150;

export const CLDR_VERSION = "48.0.0";

export async function fetchWithRetry(url: string, attempts = 4): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        return response;
      }
      last = new Error(`HTTP ${response.status}`);
      if (response.status === 404) {
        break;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw new Error(`${url}: ${last instanceof Error ? last.message : String(last)}`);
}

export async function fetchJson<T>(url: string): Promise<T> {
  return (await (await fetchWithRetry(url)).json()) as T;
}

/** Download `url` to `to` unless a file is already there. */
export async function download(url: string, to: string): Promise<void> {
  if (fs.existsSync(to) && fs.statSync(to).size > 0) {
    return;
  }
  const bytes = new Uint8Array(await (await fetchWithRetry(url)).arrayBuffer());
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(`${to}.part`, bytes);
  fs.renameSync(`${to}.part`, to);
}

export type Annotation = { default?: string[]; tts?: string[] };
export type Annotations = Record<string, Annotation>;

/** CLDR's emoji names (`tts`) and keywords (`default`) in one language, pinned to one release. */
export async function cldrAnnotations(language: string): Promise<Annotations> {
  const base = `https://raw.githubusercontent.com/unicode-org/cldr-json/${CLDR_VERSION}/cldr-json`;
  const plain = await fetchJson<{ annotations: { annotations: Annotations } }>(
    `${base}/cldr-annotations-full/annotations/${language}/annotations.json`,
  );
  const derived = await fetchJson<{ annotationsDerived: { annotations: Annotations } }>(
    `${base}/cldr-annotations-derived-full/annotationsDerived/${language}/annotations.json`,
  );
  return { ...derived.annotationsDerived.annotations, ...plain.annotations.annotations };
}

/** CLDR keys some sequences with the variation selector and some without. */
export function cldrLookup(table: Annotations, emoji: string): Annotation {
  return table[emoji] ?? table[emoji.replace(/️/g, "")] ?? {};
}

/** Letters and digits only, lower case, one word each: what a tag can be in a file name. */
export function wordsOf(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word !== "");
}

/**
 * A file name from words: each once, in order, until the name is as long as
 * it may be. `required` words (a source's own tag) always fit, at the end.
 */
export function nameFromWords(words: string[], required: string[] = []): string {
  const must = required.flatMap(wordsOf);
  const budget = MAX_NAME_BYTES - must.reduce((sum, word) => sum + Buffer.byteLength(word) + 1, 0);
  const kept: string[] = [];
  let bytes = 0;
  for (const word of words) {
    if (kept.includes(word) || must.includes(word)) {
      continue;
    }
    const cost = Buffer.byteLength(word) + (kept.length > 0 ? 1 : 0);
    if (bytes + cost > budget) {
      break;
    }
    kept.push(word);
    bytes += cost;
  }
  return [...kept, ...must].join("_");
}

/** The bundled ffmpeg for this machine, by the rule `electron/lib/ffmpeg.ts` uses. */
export function bundledFfmpeg(): string {
  const dir =
    process.platform === "win32"
      ? "win32-x64"
      : process.arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64";
  const binary = path.join("bin", dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (!fs.existsSync(binary)) {
    throw new Error(`no bundled ffmpeg at ${binary}; run this from the repository root`);
  }
  return path.resolve(binary);
}

/**
 * Write a GIF from `input` (anything ffmpeg reads: an APNG, a frame
 * pattern), quantised once per GIF with transparency kept, and only the
 * changed rectangle stored per frame.
 */
export function encodeGif(ffmpeg: string, input: string[], to: string): void {
  execFileSync(
    ffmpeg,
    [
      "-v", "error", "-y", ...input,
      "-filter_complex",
      "[0:v]split[a][b];[a]palettegen=reserve_transparent=1:stats_mode=diff[p];" +
        "[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle:alpha_threshold=128",
      "-loop", "0", "-f", "gif", `${to}.part`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  fs.renameSync(`${to}.part`, to);
}

/** Run `work` over `items`, `jobs` at a time. */
export async function eachLimited<T>(
  items: T[],
  jobs: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await work(items[index], index);
      }
    }),
  );
}

const MIT = (holder: string) => `Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * Every source's credit and licence, in one file beside the GIFs. Written by
 * each fetcher, whole, so running any one of them leaves it complete.
 */
export const CREDITS = `# Credits

## Noto Emoji Animation (files without fluent or 날씨 among their words)

Noto Emoji Animation by Google, https://googlefonts.github.io/noto-emoji-animation/
Licensed under CC BY 4.0, https://creativecommons.org/licenses/by/4.0/
The GIFs are as published; only their file names were changed.

## Fluent Emoji (files with "fluent" among their words)

Fluent Emoji by Microsoft, https://github.com/microsoft/fluentui-emoji-animated
Converted from animated PNG to GIF and renamed. Licensed under the MIT License:

${MIT("Microsoft Corporation.")}
## Meteocons (files with "날씨" and "weather" among their words)

Meteocons by Bas Milius, https://meteocons.com, https://github.com/basmilius/meteocons
The "fill" style, rendered from Lottie to GIF and renamed. Licensed under the MIT License:

${MIT("2020-present Bas Milius")}
## Keywords

The English and Korean words in the emoji file names are from the Unicode CLDR
emoji annotations, release ${CLDR_VERSION}, (c) Unicode, Inc., Unicode License v3,
https://www.unicode.org/license.txt
`;

export function writeCredits(gifsDir: string): void {
  fs.writeFileSync(path.join(gifsDir, "CREDITS.md"), CREDITS);
}
