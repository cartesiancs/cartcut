/**
 * Bringing the real app up, and taking it back down.
 *
 * Two properties matter more than anything else here.
 *
 * **Isolation.** The suite must be able to run while the developer has their
 * own Cartcut open, without touching their project, their settings or their MCP
 * token. `--user-data-dir` is an Electron switch, so that costs no production
 * code; `mcp_autostart: false` is pre-written into the isolated store so the
 * test instance never contends for port 9826 — which the real app would lose
 * anyway, since `startMcpServer` catches `EADDRINUSE` and carries on.
 *
 * **Fidelity.** Everything the user does, the test does through the same
 * controls. The two things standing in the way are native modal dialogs, which
 * cannot be driven from a page and would hang the run forever. Those are
 * stubbed *in the main process at runtime* rather than by adding a branch to
 * `electron/ipc/ipcDialog.ts`, so the shipping code has no idea a test exists
 * and the Render button is genuinely clicked.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import { REPO_ROOT } from "./paths";

/** `electron/main.ts` reveals the editor this long after `whenReady`. */
const SPLASH_DURATION_MS = 3000;

export type AppSession = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  /** Console errors and page exceptions, collected for the whole session. */
  problems: string[];
  /** Queue the next `showSaveDialog` answer. */
  answerSaveDialog: (filePath: string | null) => Promise<void>;
  /** Queue the next `showOpenDialog` answer (directories or files). */
  answerOpenDialog: (paths: string[] | null) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Replace the two native dialogs with a queue the test controls.
 *
 * `dialog.showSaveDialog` and `dialog.showOpenDialog` are patched on the live
 * `electron` module object, which `electron/ipc/ipcDialog.ts` reaches through
 * its own import — same object, so the patch is seen. Answers are queued rather
 * than fixed so a test can walk through several dialogs in order, and an
 * unqueued dialog resolves as *cancelled* rather than hanging: a hang here
 * costs the whole run its timeout with no clue why, and a cancel surfaces as a
 * failed assertion at the place that expected the dialog to be answered.
 */
async function installDialogStubs(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as any;
    g.__cartcutDialogQueue = { save: [] as (string | null)[], open: [] as (string[] | null)[] };

    dialog.showSaveDialog = (async (...args: any[]) => {
      const next = g.__cartcutDialogQueue.save.shift();
      const filePath = next === undefined ? null : next;
      g.__cartcutDialogLog = [...(g.__cartcutDialogLog ?? []), { kind: "save", filePath, args: args.length }];
      return filePath == null
        ? { canceled: true, filePath: undefined }
        : { canceled: false, filePath };
    }) as any;

    dialog.showOpenDialog = (async (...args: any[]) => {
      const next = g.__cartcutDialogQueue.open.shift();
      const filePaths = next === undefined ? null : next;
      g.__cartcutDialogLog = [...(g.__cartcutDialogLog ?? []), { kind: "open", filePaths, args: args.length }];
      return filePaths == null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths };
    }) as any;
  });
}

export type LaunchOptions = {
  /** Kept after the run instead of deleted — useful when a failure needs the store inspected. */
  keepUserData?: boolean;
  /** Extra Electron/Chromium switches. */
  extraArgs?: string[];
};

export async function launchApp(options: LaunchOptions = {}): Promise<AppSession> {
  for (const required of ["main/main.js", "apps/app/dist/index.js"]) {
    if (!fs.existsSync(path.join(REPO_ROOT, required))) {
      throw new Error(
        `${required} is missing — the app has not been built.\n` +
        `Run: npx tsc -p ./.tsconfig && npx webpack --mode=development`,
      );
    }
  }

  const userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cartcut-e2e-"));

  // electron-store reads `config.json` out of userData on first access, so
  // seeding it before launch is how the test instance asks for two things
  // without any production code knowing a test exists. Both flags are ones the
  // app already honours:
  //
  //   mcp_autostart        `electron/main.ts` skips `startMcpServer()`, so the
  //                        run never contends for port 9826 with the
  //                        developer's own editor.
  //   ONBOARDING_COMPLETED `features/onboarding/onboardingOverlay.ts` shows a
  //                        four-card first-run tour whose scrim covers the
  //                        whole editor and swallows every click. A fresh
  //                        userData means first run *every* time. Seeding the
  //                        flag makes the app behave as it does for a returning
  //                        user, which is the state the editor is under test
  //                        in; clicking through the tour would only be testing
  //                        the tour.
  await fsp.writeFile(
    path.join(userDataDir, "config.json"),
    JSON.stringify({ mcp_autostart: false, ONBOARDING_COMPLETED: true }, null, 2),
  );

  const app = await electron.launch({
    args: [REPO_ROOT, `--user-data-dir=${userDataDir}`, ...(options.extraArgs ?? [])],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Set in some developer shells; with it on, `require("electron")` hands
      // back the binary path as a string and `electron-is-dev` throws.
      ELECTRON_RUN_AS_NODE: undefined as unknown as string,
      CARTCUT_E2E: "1",
    },
  });

  // The splash is also a BrowserWindow, so "the first window" is a coin flip.
  // Select the editor by its URL.
  const page = await waitForEditorPage(app);

  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  // The stack, not just the message. "Cannot read properties of undefined" is
  // useless on its own and is exactly the shape of error a renderer under
  // export load produces.
  page.on("pageerror", (error) =>
    problems.push(`pageerror: ${error.message}\n${error.stack ?? "(no stack)"}`),
  );

  await page.waitForLoadState("domcontentloaded");

  // `apps/app/index.html`'s <script> tag is not optional: modals go through
  // `bootstrap.Modal`, so without it the run fails at the Render button with an
  // error that says nothing about the missing dependency. Fail here instead.
  // This is deliberately separate from the `window.CARTCUT` wait below — one
  // says the page's dependencies loaded, the other that the bundle evaluated,
  // and keeping Bootstrap out of the bundle is what keeps them two signals.
  await page
    .waitForFunction(() => (globalThis as any).bootstrap?.Modal != null, undefined, { timeout: 30_000 })
    .catch(() => {
      throw new Error(
        "bootstrap did not load. apps/app/index.html loads it from " +
        "apps/app/vendor/bootstrap.bundle.min.js, a committed copy of the installed package — " +
        "check that the file is present and that the <script> tag still points at it.",
      );
    });

  // `window.CARTCUT` is the webpack library export; its presence means the
  // renderer bundle finished evaluating and the components are defined.
  await page.waitForFunction(() => (globalThis as any).CARTCUT?.renderTimelineAtTime != null, undefined, {
    timeout: 60_000,
  });

  // The editor is created with `show: false` and revealed on a timer. This wait
  // has to come before any visibility assertion: a window the compositor has
  // never painted reports every element as hidden, so `element-timeline-canvas`
  // resolves but never becomes visible and the wait burns its whole timeout.
  await app.evaluate(async ({ BrowserWindow }, splashMs) => {
    const editor = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith("index.html"));
    if (editor == null) return;
    if (editor.isVisible()) return;
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + splashMs + 10_000;
      const tick = () => {
        if (editor.isDestroyed() || editor.isVisible() || Date.now() > deadline) resolve();
        else setTimeout(tick, 100);
      };
      tick();
    });
  }, SPLASH_DURATION_MS);

  // Wait on the canvases, not on the custom elements that contain them.
  //
  // Most of this app's components are `display: inline` wrappers with a 0x0
  // box — `element-timeline-canvas` measures 0x0 while the
  // `#elementTimelineCanvasRef` inside it is 675x302. Playwright calls a
  // zero-area element hidden, so waiting for the tag to be "visible" waits
  // forever on a component that is on screen and working. Every selector in
  // `ui.ts` follows the same rule.
  await page.waitForSelector("#elementTimelineCanvasRef", { state: "visible", timeout: 60_000 });
  await page.waitForSelector("#elementPreviewCanvasRef", { state: "visible", timeout: 60_000 });

  // The seeded flag is read asynchronously, so the scrim can be up briefly
  // before the overlay removes itself. Waiting for it to go is cheap; failing
  // here names the problem, whereas letting it stand turns every later click
  // into "element intercepts pointer events" 60 seconds at a time.
  await page
    .waitForSelector(".onboarding-scrim", { state: "detached", timeout: 20_000 })
    .catch(() => {
      throw new Error(
        "the onboarding overlay is still up — its scrim swallows every click. " +
        "Check that ONBOARDING_COMPLETED is still the flag onboardingOverlay.ts reads.",
      );
    });

  await installDialogStubs(app);

  const answerSaveDialog = async (filePath: string | null) => {
    await app.evaluate((_electronApi, value) => {
      (globalThis as any).__cartcutDialogQueue.save.push(value);
    }, filePath);
  };

  const answerOpenDialog = async (paths: string[] | null) => {
    await app.evaluate((_electronApi, value) => {
      (globalThis as any).__cartcutDialogQueue.open.push(value);
    }, paths);
  };

  const close = async () => {
    try {
      // `mainWindow.on("close")` calls preventDefault and asks the renderer to
      // confirm, so a polite close never completes without a user. Exit the
      // process instead.
      await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
      await app.close().catch(() => {});
    } finally {
      if (!options.keepUserData) {
        await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };

  return { app, page, userDataDir, problems, answerSaveDialog, answerOpenDialog, close };
}

/**
 * The editor window, chosen by URL.
 *
 * Not by title: it has changed at least once already, and with devtools open
 * there is a second page whose title matches nothing useful. A title match that
 * misses silently answers every later `evaluate` about the wrong document,
 * which reads exactly like an empty project.
 */
async function waitForEditorPage(app: ElectronApplication, timeoutMs = 60_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (/index\.html(\?|#|$)/.test(candidate.url())) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const seen = app.windows().map((w) => w.url()).join("\n  ");
  throw new Error(`editor window never appeared. Windows seen:\n  ${seen || "(none)"}`);
}
