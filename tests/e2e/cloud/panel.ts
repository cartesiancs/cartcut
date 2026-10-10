/**
 * What the cloud-content scripts share: a quiet launch and the FX panel.
 *
 * Not specs. `renderThumbnails.ts` and `verifyServed.ts` are run by hand with
 * `npx jiti`, so they live outside `specs/` where Playwright never collects
 * them, and outside the root program where webpack would typecheck them.
 */

import path from "node:path";
import { launchApp, type AppSession, type LaunchOptions } from "../harness/launch";
import { quietWindows } from "../harness/graphicProbe";

export type FxPanelKind = "effect" | "transition" | "graphic";

/**
 * `launchApp`, hidden and muted from the first window on (`quiet.cjs`, through
 * NODE_OPTIONS) rather than only after the launch returns.
 */
export async function launchQuiet(options: LaunchOptions): Promise<AppSession> {
  const quiet = path.join(__dirname, "quiet.cjs");
  if (!(process.env.NODE_OPTIONS ?? "").includes(quiet)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS ?? "", "--require", JSON.stringify(quiet)].join(" ").trim();
  }
  const session = await launchApp(options);
  await quietWindows(session);
  return session;
}

/** Show the FX tab and one kind's grid, the way the panel's own tab bar does. */
export async function openPanel(session: AppSession, kind: FxPanelKind): Promise<void> {
  const { page } = session;
  await page.evaluate(() =>
    (document.querySelector('#sidebar button[data-bs-target="#nav-fx"]') as HTMLElement | null)?.click(),
  );
  await page.waitForFunction(
    () => ((document.querySelector("#nav-fx") as HTMLElement | null)?.getBoundingClientRect().height ?? 0) > 0,
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate((k) => {
    (document.querySelector("control-ui-fx") as any).activePanel = k;
  }, kind);
  await page.waitForFunction(
    (k) => {
      const browser = document.querySelector(`fx-preset-browser[kind="${k}"]`);
      return browser != null && browser.closest(".d-none") == null;
    },
    kind,
    { timeout: 15_000 },
  );
}

/** Repaint the grid until every tile has drawn something; the ids that never did. */
export async function waitForTiles(
  session: AppSession,
  kind: FxPanelKind,
  ids: string[],
  timeoutMs: number,
): Promise<string[]> {
  return session.page.evaluate(
    async ({ k, wanted, ms }) => {
      const browser = document.querySelector(`fx-preset-browser[kind="${k}"]`) as any;
      const painted = new Set<string>();
      const deadline = performance.now() + ms;
      while (performance.now() < deadline && painted.size < wanted.length) {
        browser.paintTiles();
        for (const id of wanted) {
          if (painted.has(id)) continue;
          const canvas = browser.querySelector(`canvas[data-preset="${CSS.escape(id)}"]`) as HTMLCanvasElement | null;
          if (canvas == null) continue;
          const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
          for (let index = 3; index < data.length; index += 16) {
            if (data[index] > 0) {
              painted.add(id);
              break;
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return wanted.filter((id) => !painted.has(id));
    },
    { k: kind, wanted: ids, ms: timeoutMs },
  );
}
