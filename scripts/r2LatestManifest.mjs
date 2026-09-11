#!/usr/bin/env node
/**
 * Builds `cartcut/latest.json` and `cartcut/latest.txt` for the R2 download
 * mirror, from the JSON `gh release view <tag> --json tagName,publishedAt,assets`
 * prints. Run by `.github/workflows/mirror-r2.yml`; no dependencies, so the
 * workflow never has to `npm ci` this repo's Electron-sized tree.
 *
 *   gh release view v0.5.3 --json tagName,publishedAt,assets \
 *     | node scripts/r2LatestManifest.mjs --base-url https://download.cartesiancs.com/cartcut --out manifest
 *
 * The GitHub release is the source of truth and R2 is a mirror of it, laid out
 * as `<base>/<tag>/<asset>`. Only the two `latest.*` files ever change, so
 * everything under a tag can be cached as immutable.
 *
 * A release with no `.dmg` refuses outright rather than publishing a manifest
 * with no download in it: that is what a renamed artifact would produce, and
 * the website would otherwise quietly fall back to GitHub for every visitor.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO_URL = "https://github.com/cartesiancs/cartcut";

/** Which download slot an asset fills, or `null` for one the page never offers. */
export function slotOf(name) {
  if (name.endsWith(".blockmap")) return null;
  if (name.endsWith("-arm64.dmg")) return ["mac", "arm64"];
  if (name.endsWith(".dmg")) return ["mac", "x64"];
  if (name.endsWith(".exe")) return ["win", "x64"];
  return null;
}

export function buildManifest(release, baseUrl) {
  const tag = release.tagName;
  const base = baseUrl.replace(/\/+$/, "");
  const manifest = {
    version: tag.replace(/^v/, ""),
    tag,
    releasedAt: release.publishedAt,
    notesUrl: `${REPO_URL}/releases/tag/${encodeURIComponent(tag)}`,
    mac: {},
  };

  for (const asset of release.assets) {
    const slot = slotOf(asset.name);
    if (!slot) continue;
    const [platform, arch] = slot;
    manifest[platform] ??= {};
    manifest[platform][arch] = {
      url: `${base}/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`,
      size: asset.size,
    };
  }

  if (Object.keys(manifest.mac).length === 0) {
    throw new Error(`${tag} has no .dmg asset; refusing to publish a manifest`);
  }
  return manifest;
}

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || !process.argv[i + 1]) {
    throw new Error(`missing ${flag}`);
  }
  return process.argv[i + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const release = JSON.parse(readFileSync(0, "utf8"));
    const manifest = buildManifest(release, argOf("--base-url"));
    const out = argOf("--out");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(out, "latest.txt"), manifest.version + "\n");
    console.log(JSON.stringify(manifest, null, 2));
  } catch (err) {
    console.error(`r2LatestManifest: ${err.message}`);
    process.exit(1);
  }
}
