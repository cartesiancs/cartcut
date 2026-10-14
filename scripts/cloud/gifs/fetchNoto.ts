/**
 * Put Google's Noto Animated Emoji into the cloud catalogue's GIFs.
 *
 *     npx jiti scripts/cloud/gifs/fetchNoto.ts [--content server/content] [--cache <dir>] [--limit n]
 *
 * A cloud GIF is one file whose name is its tags, split on `_`
 * (`server/src/gifs.rs`), so this only downloads each emoji and names it:
 * 😀 becomes `grinning_face_활짝_웃는_얼굴_미소_웃음_...gif`. The words are
 * the emoji's English and Korean names and keywords from Unicode's CLDR,
 * pinned to one release so a re-run writes the same names. Then send the
 * server SIGHUP.
 *
 * 881 emoji, licensed CC BY 4.0: `gifs/CREDITS.md` is written beside them,
 * and the app credits them under the grid.
 *
 * - api.json's `host` and `asset_url_pattern` are empty, so the URL below is
 *   the one the Noto page itself loads, and it pads each codepoint to four
 *   digits where api.json does not (`a9_fe0f` is `00a9_fe0f`).
 * - Downloads are kept in `--cache` (default: the system temp folder), so a
 *   second run fetches only what is missing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NOTO_API = "https://googlefonts.github.io/noto-emoji-animation/data/api.json";
const NOTO_PAGE = "https://googlefonts.github.io/noto-emoji-animation/";
const CLDR_VERSION = "48.0.0";

/**
 * A name's length in UTF-8 bytes, before `.gif`. File systems allow 255, and
 * the install path on Windows has to fit in 260 characters with the user's
 * profile folder in front of it.
 */
const MAX_NAME_BYTES = 150;

const gifUrl = (codepoint: string) =>
  `https://fonts.gstatic.com/s/e/notoemoji/latest/${codepoint
    .split("_")
    .map((hex) => hex.padStart(4, "0"))
    .join("_")}/512.gif`;

const cldrUrl = (file: "annotations" | "annotationsDerived", language: string) =>
  `https://raw.githubusercontent.com/unicode-org/cldr-json/${CLDR_VERSION}/cldr-json/` +
  (file === "annotations"
    ? `cldr-annotations-full/annotations/${language}/annotations.json`
    : `cldr-annotations-derived-full/annotationsDerived/${language}/annotations.json`);

type NotoIcon = { codepoint: string; tags: string[] };
type Annotation = { default?: string[]; tts?: string[] };
type Annotations = Record<string, Annotation>;

async function fetchWithRetry(url: string, attempts = 4): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
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

async function fetchJson<T>(url: string): Promise<T> {
  return (await (await fetchWithRetry(url)).json()) as T;
}

async function annotationsFor(language: string): Promise<Annotations> {
  const plain = await fetchJson<{ annotations: { annotations: Annotations } }>(
    cldrUrl("annotations", language),
  );
  const derived = await fetchJson<{ annotationsDerived: { annotations: Annotations } }>(
    cldrUrl("annotationsDerived", language),
  );
  return { ...derived.annotationsDerived.annotations, ...plain.annotations.annotations };
}

/** CLDR keys some sequences with the variation selector and some without. */
function lookup(table: Annotations, codepoint: string): Annotation {
  const emoji = String.fromCodePoint(...codepoint.split("_").map((hex) => parseInt(hex, 16)));
  return table[emoji] ?? table[emoji.replace(/️/g, "")] ?? {};
}

/** Letters and digits only, lower case, one word each: what a tag can be in a file name. */
function wordsOf(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word !== "");
}

/**
 * The file name for one emoji: its English name, its Korean name, then
 * keywords, each word once, until the name is as long as it may be.
 */
function nameFor(icon: NotoIcon, en: Annotations, ko: Annotations): string {
  const english = lookup(en, icon.codepoint);
  const korean = lookup(ko, icon.codepoint);
  const words: string[] = [];
  let bytes = 0;
  for (const word of [
    ...(english.tts ?? []).flatMap(wordsOf),
    ...(korean.tts ?? []).flatMap(wordsOf),
    ...(korean.default ?? []).flatMap(wordsOf),
    ...(english.default ?? []).flatMap(wordsOf),
    ...icon.tags.flatMap(wordsOf),
  ]) {
    if (words.includes(word)) {
      continue;
    }
    const cost = Buffer.byteLength(word) + (words.length > 0 ? 1 : 0);
    if (bytes + cost > MAX_NAME_BYTES) {
      break;
    }
    words.push(word);
    bytes += cost;
  }
  return words.length > 0 ? words.join("_") : icon.codepoint;
}

const CREDITS = `Noto Emoji Animation by Google, ${NOTO_PAGE}
Licensed under CC BY 4.0, https://creativecommons.org/licenses/by/4.0/
The GIFs are as published; only their file names were changed.

The words in the file names are from the Unicode CLDR emoji annotations,
release ${CLDR_VERSION}, (c) Unicode, Inc., Unicode License v3,
https://www.unicode.org/license.txt
`;

async function main() {
  const argv = process.argv.slice(2);
  let content = path.join("server", "content");
  let cache = path.join(os.tmpdir(), "cartcut-noto-cache");
  let limit = Infinity;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--content") content = argv[++index];
    else if (arg === "--cache") cache = argv[++index];
    else if (arg === "--limit") limit = Number(argv[++index]);
    else {
      console.error("unknown argument " + arg);
      process.exit(2);
    }
  }
  const gifs = path.join(content, "gifs");
  fs.mkdirSync(gifs, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });

  const [api, en, ko] = await Promise.all([
    fetchJson<{ icons: NotoIcon[] }>(NOTO_API),
    annotationsFor("en"),
    annotationsFor("ko"),
  ]);
  const icons = api.icons.slice(0, limit);

  // Two emoji with the same words would be one file; the second keeps its codepoint.
  const names = new Set<string>();
  const jobs = icons.map((icon) => {
    let name = nameFor(icon, en, ko);
    if (names.has(name)) {
      name = `${name}_${icon.codepoint}`;
    }
    names.add(name);
    return { icon, file: `${name}.gif` };
  });

  let done = 0;
  const failed: string[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const { icon, file } = jobs[cursor++];
      try {
        const cached = path.join(cache, `${icon.codepoint}.gif`);
        if (!fs.existsSync(cached) || fs.readFileSync(cached).subarray(0, 3).toString("latin1") !== "GIF") {
          const bytes = new Uint8Array(await (await fetchWithRetry(gifUrl(icon.codepoint))).arrayBuffer());
          fs.writeFileSync(`${cached}.part`, bytes);
          fs.renameSync(`${cached}.part`, cached);
        }
        fs.copyFileSync(cached, path.join(gifs, file));
      } catch (error) {
        failed.push(`${icon.codepoint}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (++done % 100 === 0) {
        console.log(`${done}/${jobs.length}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  fs.writeFileSync(path.join(gifs, "CREDITS.md"), CREDITS);
  for (const line of failed) {
    console.log("failed " + line);
  }
  console.log(`${jobs.length - failed.length} GIFs written to ${gifs}, ${failed.length} failed.`);
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
