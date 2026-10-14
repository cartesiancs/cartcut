/**
 * Put Microsoft's animated Fluent Emoji into the cloud catalogue's GIFs.
 *
 *     npx jiti scripts/cloud/gifs/fetchFluent.ts [--content server/content] [--cache <dir>] [--limit n] [--dry-run]
 *
 * 746 emoji from github.com/microsoft/fluentui-emoji-animated (MIT), the
 * default skin tone of each. They are 256px animated PNGs kept in Git LFS, so
 * each is downloaded from the LFS media host and turned into a GIF with the
 * bundled ffmpeg (`gifNames.ts#encodeGif`).
 *
 * Named like the Noto emoji, from the emoji's English and Korean names and
 * keywords, with `fluent` always among the words: the same emoji in Noto's
 * style has the same words otherwise, and two GIFs cannot share a name. It
 * also lets a search for "fluent" find the whole style.
 *
 * Downloads (about 1.5 GB) are kept in `--cache`, default the system temp
 * folder, so a second run fetches only what is missing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  bundledFfmpeg,
  cldrAnnotations,
  cldrLookup,
  download,
  eachLimited,
  encodeGif,
  fetchJson,
  nameFromWords,
  wordsOf,
  writeCredits,
} from "./gifNames";

const REPO = "microsoft/fluentui-emoji-animated";
const BRANCH = "main";

type Metadata = { glyph?: string; tts?: string; cldr?: string; keywords?: string[]; unicode?: string };
type Tree = { tree: { path: string; type: string }[]; truncated?: boolean };

const encodePath = (file: string) => file.split("/").map(encodeURIComponent).join("/");

/**
 * Each emoji's default animation: `assets/<Emoji>/animated/*.png`, or for an
 * emoji with skin tones, `assets/<Emoji>/Default/animated/*.png`.
 */
function defaultAnimations(tree: Tree): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of tree.tree) {
    if (entry.type !== "blob" || !entry.path.endsWith(".png")) {
      continue;
    }
    const parts = entry.path.split("/");
    const plain = parts.length === 4 && parts[2] === "animated";
    const toned = parts.length === 5 && parts[2] === "Default" && parts[3] === "animated";
    if (parts[0] === "assets" && (plain || toned)) {
      found.set(parts[1], entry.path);
    }
  }
  return found;
}

async function main() {
  const argv = process.argv.slice(2);
  let content = path.join("server", "content");
  let cache = path.join(os.tmpdir(), "cartcut-fluent-cache");
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
  const ffmpeg = bundledFfmpeg();

  const [tree, en, ko] = await Promise.all([
    fetchJson<Tree>(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`),
    cldrAnnotations("en"),
    cldrAnnotations("ko"),
  ]);
  if (tree.truncated) {
    throw new Error("the repository's file list came back truncated");
  }
  const emoji = [...defaultAnimations(tree).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, limit);
  console.log(`${emoji.length} animated emoji`);

  // The words come from each emoji's metadata.json, which is small and not in LFS.
  fs.mkdirSync(cache, { recursive: true });
  const metadata = new Map<string, Metadata>();
  await eachLimited(emoji, 8, async ([folder]) => {
    const local = path.join(cache, encodeURIComponent(folder) + ".json");
    await download(
      `https://raw.githubusercontent.com/${REPO}/${BRANCH}/assets/${encodeURIComponent(folder)}/metadata.json`,
      local,
    );
    metadata.set(folder, JSON.parse(fs.readFileSync(local, "utf8")) as Metadata);
  });

  const names = new Set<string>();
  const jobs = emoji.map(([folder, file]) => {
    const meta = metadata.get(folder) ?? {};
    const glyph = meta.glyph ?? "";
    const english = cldrLookup(en, glyph);
    const korean = cldrLookup(ko, glyph);
    let name = nameFromWords(
      [
        ...wordsOf(meta.tts ?? meta.cldr ?? folder),
        ...(korean.tts ?? []).flatMap(wordsOf),
        ...(korean.default ?? []).flatMap(wordsOf),
        ...(meta.keywords ?? []).flatMap(wordsOf),
        ...(english.default ?? []).flatMap(wordsOf),
      ],
      ["fluent"],
    );
    if (names.has(name)) {
      name = `${name}_${(meta.unicode ?? folder).replace(/\s+/g, "_")}`;
    }
    names.add(name);
    return { folder, file, gif: `${name}.gif` };
  });
  if (dryRun) {
    for (const job of jobs) {
      console.log(job.gif);
    }
    return;
  }

  fs.mkdirSync(gifs, { recursive: true });
  const failed: string[] = [];
  let done = 0;
  await eachLimited(jobs, 6, async ({ folder, file, gif }) => {
    try {
      const apng = path.join(cache, encodeURIComponent(folder) + ".png");
      await download(`https://media.githubusercontent.com/media/${REPO}/${BRANCH}/${encodePath(file)}`, apng);
      // An LFS pointer instead of the image would be a few hundred bytes of text.
      if (fs.readFileSync(apng).subarray(1, 4).toString("latin1") !== "PNG") {
        fs.rmSync(apng);
        throw new Error("the download is not a PNG");
      }
      encodeGif(ffmpeg, ["-i", apng], path.join(gifs, gif));
    } catch (error) {
      failed.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (++done % 50 === 0) {
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
