/**
 * The cloud catalogue as a user meets it: served, listed, downloaded, loaded.
 *
 *     npx jiti tests/e2e/cloud/verifyServed.ts [--url http://127.0.0.1:8797]
 *
 * Needs a server already running on `--url` over `server/content`. Never the
 * developer's own on 8787: start a second one, for example
 *
 *     cd server && CARTCUT_CLOUD_BIND=127.0.0.1:8797 CARTCUT_CLOUD_CONTENT=content ./target/debug/cartcut-cloud
 *
 * `renderThumbnails.ts` installs folders straight from disk, which proves the
 * presets but not the path between: the server's index, the app's catalog
 * parser, the per-file download with its size and digest checks, and the
 * registry picking the result up. This takes that path for every item, in a
 * hidden instance with cloud switched on and pointed at the server:
 *
 *   1. every kind's grid shows one cloud tile per catalog item, each with a
 *      thumbnail that decoded at 192x108;
 *   2. every item downloads through `electronAPI.req.cloud.download`;
 *   3. after a reload every one is in the registry with origin `cloud`, and
 *      its tile paints, with no `preset: skipped` and nothing failing to
 *      compile on the console.
 *
 * Exit status: 0 pass, 1 failures, 2 setup failure.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppSession } from "../harness/launch";
import { launchQuiet, openPanel, waitForTiles, type FxPanelKind } from "./panel";

const KINDS: FxPanelKind[] = ["effect", "transition", "graphic"];

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback;
}

const failures: string[] = [];

async function main() {
  const url = argument("--url", "http://127.0.0.1:8797").replace(/\/+$/, "");

  // What the server says it serves, read directly, as the yardstick.
  const catalogs = new Map<FxPanelKind, string[]>();
  try {
    for (const kind of KINDS) {
      const response = await fetch(url + "/v1/catalog/" + kind);
      const body = (await response.json()) as { items: { id: string }[] };
      catalogs.set(kind, body.items.map((item) => item.id));
    }
  } catch (error) {
    console.error("no server at " + url + ": " + String(error));
    process.exit(2);
  }
  console.log("served: " + KINDS.map((kind) => kind + " " + catalogs.get(kind)!.length).join(", "));

  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cartcut-served-"));
  let session: AppSession | null = null;
  const shutdown = async (code: number) => {
    if (session != null) await session.close().catch(() => {});
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(130));

  try {
    session = await launchQuiet({
      userDataDir,
      config: { cloud_api_enabled: true, cloud_api_url: url },
    });
  } catch (error) {
    console.error("launch failed: " + String(error));
    return shutdown(2);
  }
  const consoleLines: string[] = [];
  session.page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") consoleLines.push(message.text());
  });
  const { page } = session;

  // 1. The tiles, before anything is downloaded.
  for (const kind of KINDS) {
    const ids = catalogs.get(kind)!;
    if (ids.length === 0) continue;
    await openPanel(session, kind);
    const missing: string[] = await page.evaluate(
      async ({ k, wanted }) => {
        const browser = document.querySelector(`fx-preset-browser[kind="${k}"]`)!;
        const deadline = performance.now() + 60_000;
        let left = wanted;
        while (left.length > 0 && performance.now() < deadline) {
          left = wanted.filter((id) => {
            const tile = browser.querySelector(`div.asset[data-cloud="${CSS.escape(id)}"]`);
            const image = tile?.querySelector("img.asset-thumb-img") as HTMLImageElement | null;
            return image == null || !image.complete || image.naturalWidth !== 192;
          });
          if (left.length > 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return left;
      },
      { k: kind, wanted: ids },
    );
    for (const id of missing) failures.push(kind + " " + id + ": no cloud tile with a 192px thumbnail");
  }

  // 2. Every download, four at a time.
  for (const kind of KINDS) {
    const results: { id: string; ok: boolean; detail: string }[] = await page.evaluate(
      async ({ k, ids }) => {
        const cloud = (window as any).electronAPI.req.cloud;
        const out: { id: string; ok: boolean; detail: string }[] = [];
        const queue = ids.slice();
        const worker = async () => {
          for (let id = queue.shift(); id != null; id = queue.shift()) {
            try {
              const result = await cloud.download(k, id, "verify-" + k + "-" + id);
              out.push({ id, ok: result?.ok === true, detail: JSON.stringify(result) });
            } catch (error) {
              out.push({ id, ok: false, detail: String(error) });
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        return out;
      },
      { k: kind, ids: catalogs.get(kind)! },
    );
    for (const result of results.filter((r) => !r.ok)) {
      failures.push(kind + " " + result.id + ": download failed " + result.detail);
    }
  }

  // 3. The registry, and the installed tiles.
  await page.evaluate(() => (globalThis as any).CARTCUT.loadPresets());
  for (const kind of KINDS) {
    const ids = catalogs.get(kind)!;
    const loaded: string[] = await page.evaluate(
      (k) =>
        (globalThis as any).CARTCUT.presetsOfKind(k)
          .filter((preset: any) => preset.origin === "cloud")
          .map((preset: any) => preset.id),
      kind,
    );
    for (const id of ids.filter((id) => !loaded.includes(id))) {
      failures.push(kind + " " + id + ": downloaded but not in the registry");
    }
    await openPanel(session, kind);
    const unpainted = await waitForTiles(session, kind, ids, 120_000);
    for (const id of unpainted) failures.push(kind + " " + id + ": installed tile never painted");
  }
  for (const line of consoleLines.filter((l) => /preset: skipped|did not compile|could not rasterise/.test(l))) {
    failures.push("console: " + line.split("\n")[0]);
  }

  for (const failure of failures) console.log("FAIL " + failure);
  const total = KINDS.reduce((sum, kind) => sum + catalogs.get(kind)!.length, 0);
  console.log((failures.length > 0 ? "FAIL" : "ok") + ": " + total + " items served, " + failures.length + " failures");
  return shutdown(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
