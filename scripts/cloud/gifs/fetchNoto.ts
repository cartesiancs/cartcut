/**
 * Put Google's Noto Animated Emoji into the cloud catalogue's GIFs.
 *
 *     npx jiti scripts/cloud/gifs/fetchNoto.ts [--content server/content] [--cache <dir>] [--limit n] [--dry-run]
 *
 * A cloud GIF is one file whose name is its tags, split on `_`
 * (`server/src/gifs.rs`), so this only downloads each emoji and names it:
 * 😀 becomes `grinning_face_활짝_웃는_얼굴_미소_웃음_...gif`, from the emoji's
 * English and Korean names and keywords in Unicode's CLDR (`gifNames.ts`).
 * Then send the server SIGHUP.
 *
 * 881 emoji, licensed CC BY 4.0, credited in `gifs/CREDITS.md` and under the
 * app's grid.
 *
 * - api.json's `host` and `asset_url_pattern` are empty, so the URL below is
 *   the one the Noto page itself loads, and it pads each codepoint to four
 *   digits where api.json does not (`a9_fe0f` is `00a9_fe0f`).
 * - Downloads are kept in `--cache` (default: the system temp folder), so a
 *   second run fetches only what is missing. `--dry-run` prints the names.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  cldrAnnotations,
  cldrLookup,
  eachLimited,
  fetchJson,
  fetchWithRetry,
  nameFromWords,
  wordsOf,
  writeCredits,
  type Annotations,
} from "./gifNames";

const NOTO_API = "https://googlefonts.github.io/noto-emoji-animation/data/api.json";

const gifUrl = (codepoint: string) =>
  `https://fonts.gstatic.com/s/e/notoemoji/latest/${codepoint
    .split("_")
    .map((hex) => hex.padStart(4, "0"))
    .join("_")}/512.gif`;

type NotoIcon = { codepoint: string; tags: string[] };

/** Its English name, its Korean name, then keywords. */
function nameFor(icon: NotoIcon, en: Annotations, ko: Annotations): string {
  const emoji = String.fromCodePoint(...icon.codepoint.split("_").map((hex) => parseInt(hex, 16)));
  const english = cldrLookup(en, emoji);
  const korean = cldrLookup(ko, emoji);
  const name = nameFromWords([
    ...(english.tts ?? []).flatMap(wordsOf),
    ...(korean.tts ?? []).flatMap(wordsOf),
    ...(korean.default ?? []).flatMap(wordsOf),
    ...(english.default ?? []).flatMap(wordsOf),
    ...icon.tags.flatMap(wordsOf),
  ]);
  return name !== "" ? name : icon.codepoint;
}

async function main() {
  const argv = process.argv.slice(2);
  let content = path.join("server", "content");
  let cache = path.join(os.tmpdir(), "cartcut-noto-cache");
  let limit = Infinity;
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--content") content = argv[++index];
    else if (arg === "--cache") cache = argv[++index];
    else if (arg === "--limit") limit = Number(argv[++index]);
    else if (arg === "--dry-run") dryRun = true;
    else {
      console.error("unknown argument " + arg);
      process.exit(2);
    }
  }
  const gifs = path.join(content, "gifs");

  const [api, en, ko] = await Promise.all([
    fetchJson<{ icons: NotoIcon[] }>(NOTO_API),
    cldrAnnotations("en"),
    cldrAnnotations("ko"),
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
  if (dryRun) {
    for (const job of jobs) {
      console.log(job.file);
    }
    return;
  }

  fs.mkdirSync(gifs, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const failed: string[] = [];
  let done = 0;
  await eachLimited(jobs, 6, async ({ icon, file }) => {
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
  });

  writeCredits(gifs);
  for (const line of failed) {
    console.log("failed " + line);
  }
  console.log(`${jobs.length - failed.length} GIFs written to ${gifs}, ${failed.length} failed.`);
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();
