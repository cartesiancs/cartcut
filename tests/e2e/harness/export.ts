/**
 * Clicking Export, and waiting the way a person would have to.
 *
 * The click is genuine: `dialog.showSaveDialog` is stubbed in the main process
 * (see `launch.ts`), so `features/export/exportSession.ts#startExport` runs
 * exactly as it does for a user — the existing-file removal, the snapshot, the
 * abort controller and the frame loop all included.
 *
 * Progress is read from `exportStore` rather than scraped out of a dialog.
 * There is no dialog any more: the export button lives on the title bar, shows
 * a ring, and opens a popover only when clicked — which is what lets the user
 * keep editing while a render runs.
 *
 * Completion is taken from the IPC events, not from the UI. `PROCESSING_FINISH`
 * and `render:v2:error` are what the main process actually emits, and the second
 * exists precisely because FFmpeg can fail *after* the last frame is written —
 * a run that watched only the progress bar would call that a success. The
 * completion dialog is checked too, but as a UI assertion rather than as the
 * completion signal.
 *
 * The stall detector is the other half. An export that deadlocks — a pipe that
 * stops draining, a seek that never resolves — otherwise burns the whole test
 * timeout and reports "timed out" with no indication of where. Watching the
 * frame counter stop moving turns that into "no progress for 120s at frame
 * 8,412 of 18,000", which names the failure.
 */

import { expect, type Page } from "@playwright/test";

import type { AppSession } from "./launch";

export type ExportOutcome = {
  destination: string;
  status: "finished" | "error" | "cancelled";
  /** Present when `status === "error"`; carries FFmpeg's own stderr tail. */
  error?: { message: string; stderrTail?: string; code?: number; signal?: string };
  frames: { current: number; total: number } | null;
  elapsedMs: number;
  /**
   * Progress samples, for the artifact — enough to see a stall's shape.
   *
   * `remainingMs` is the countdown the user was actually reading. It is
   * recorded because the property that matters about it is a property of the
   * *sequence* — it must never increase — and a single reading cannot show
   * that.
   */
  progress: Array<{ atMs: number; percent: number; remainingMs: number | null }>;
};

/** Longest the frame counter may stand still before the export is called stuck. */
const STALL_LIMIT_MS = 120_000;

/**
 * Subscribe to the render events before anything is clicked.
 *
 * Registering after the click would race a fast export to its own completion.
 * `ipcRenderer.on` is additive, so the app's own handlers in `event.ts` keep
 * running and the UI behaves exactly as it would unobserved.
 */
async function installRenderListeners(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as any;
    if (g.__cartcutRenderEvents != null) {
      g.__cartcutRenderEvents.length = 0;
      return;
    }
    g.__cartcutRenderEvents = [];
    const record = (kind: string) => (_event: unknown, payload: unknown) =>
      g.__cartcutRenderEvents.push({ kind, payload, at: Date.now() });

    g.electronAPI.res.render.finish(record("finish"));
    g.electronAPI.res.render.v2Error(record("v2Error"));
    g.electronAPI.res.render.v2Cancelled(record("v2Cancelled"));
    g.electronAPI.res.render.error(record("legacyError"));
  });
}

type RenderEvent = { kind: string; payload: any; at: number };

async function renderEvents(page: Page): Promise<RenderEvent[]> {
  return page.evaluate(() => (globalThis as any).__cartcutRenderEvents ?? []);
}

/**
 * The frame loop's own counter and the countdown beside it, from the store.
 *
 * Both in one `evaluate` so they describe the same instant — and note that a
 * `null` percent does not reset the stall timer below, so "no export running"
 * must read as `null` rather than as a stale number.
 *
 * `remainingMs` is a number now rather than a rendered string, which makes the
 * property that actually matters about it — that it never increases —
 * assertable without parsing "1m 20s left".
 */
async function progressSample(
  page: Page,
): Promise<{ percent: number | null; remainingMs: number | null }> {
  return page.evaluate(() => {
    const state = (globalThis as any).CARTCUT?.exportStore?.getState?.();
    if (state == null || state.phase === "idle") {
      return { percent: null, remainingMs: null };
    }
    return { percent: state.percent, remainingMs: state.remainingMs };
  });
}

/**
 * Is an export occupying the encoder?
 *
 * True through `finalizing` and `cancelling` as well as `running` — the main
 * process refuses a second export until FFmpeg has been reaped, and this is
 * the same question it answers.
 */
async function exportRunning(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const state = (globalThis as any).CARTCUT?.exportStore?.getState?.();
    return state != null && state.phase !== "idle";
  });
}

/** Which phase the export is in, for a spec that cares about the difference. */
export async function exportPhase(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (globalThis as any).CARTCUT?.exportStore?.getState?.()?.phase ?? "idle",
  );
}

export type RunExportOptions = {
  destination: string;
  /** Fail if the frame counter does not move for this long. */
  stallLimitMs?: number;
  /** Overall ceiling. Defaults to the enclosing test's own timeout. */
  timeoutMs?: number;
  onProgress?: (percent: number) => void;
};

export async function runExport(
  session: AppSession,
  options: RunExportOptions,
): Promise<ExportOutcome> {
  const { page } = session;
  const stallLimit = options.stallLimitMs ?? STALL_LIMIT_MS;
  const deadline = Date.now() + (options.timeoutMs ?? 6 * 60 * 60_000);

  await installRenderListeners(page);

  await session.answerSaveDialog(options.destination);

  const startedAt = Date.now();
  // The title bar, not the settings panel: the trigger is visible whatever
  // panel is open, so there is no tab to switch to first. The project-folder
  // gate is gone too — the save dialog decides where the file lands.
  const exportButton = page.locator("export-button .export-trigger");
  await expect(exportButton).toBeVisible();
  await exportButton.click();

  // The click resolves as soon as the handler yields at its first await, so the
  // export is still starting here.
  const progress: ExportOutcome["progress"] = [];
  let lastPercent = -1;
  let lastRemainingMs: number | null = null;
  let lastMoveAt = Date.now();
  let sawRunning = false;

  for (;;) {
    const events = await renderEvents(page);
    const terminal = events.find((e) => e.kind === "finish" || e.kind === "v2Error" || e.kind === "v2Cancelled" || e.kind === "legacyError");

    if (terminal != null) {
      const elapsedMs = Date.now() - startedAt;
      if (terminal.kind === "finish") {
        return {
          // `event.ts`'s own handler ignores the payload, but the main process
          // does send `{ destination }` — worth preferring over what we asked
          // for, so a mismatch shows up rather than being assumed away.
          destination: terminal.payload?.destination ?? options.destination,
          status: "finished",
          frames: null,
          elapsedMs,
          progress,
        };
      }
      if (terminal.kind === "v2Cancelled") {
        return { destination: options.destination, status: "cancelled", frames: null, elapsedMs, progress };
      }
      return {
        destination: options.destination,
        status: "error",
        error: {
          message: String(terminal.payload?.message ?? terminal.payload ?? "unknown render error"),
          stderrTail: terminal.payload?.stderrTail,
          code: terminal.payload?.code,
          signal: terminal.payload?.signal,
        },
        frames: null,
        elapsedMs,
        progress,
      };
    }

    const running = await exportRunning(page);
    if (running) sawRunning = true;

    const { percent, remainingMs } = await progressSample(page);
    if (
      percent != null &&
      (percent !== lastPercent || remainingMs !== lastRemainingMs)
    ) {
      // Only the *bar* clears the stall timer. The countdown ticks once a
      // second on a timer of its own, by design — it keeps moving precisely
      // when the frame loop does not — so letting it reset `lastMoveAt` would
      // mean a wedged export never trips the detector again.
      if (percent !== lastPercent) {
        lastMoveAt = Date.now();
      }
      lastPercent = percent;
      lastRemainingMs = remainingMs;
      progress.push({ atMs: Date.now() - startedAt, percent, remainingMs });
      options.onProgress?.(percent);
    }

    // The frame loop can finish and hand off to FFmpeg's own flush. The phase
    // stays non-idle through that, so this only fires once the store has
    // genuinely settled — and even then an event is given a chance to arrive.
    if (sawRunning && !running) {
      const settled = await waitForTerminalEvent(page, 120_000);
      if (settled == null) {
        throw new Error(
          `export stopped running at ${lastPercent}% but emitted no finish or error event within 120s.\n` +
          `This is the shape of a frame loop that threw somewhere the handler swallowed it.`,
        );
      }
      continue;
    }

    if (Date.now() - lastMoveAt > stallLimit) {
      throw new Error(
        `export made no progress for ${Math.round(stallLimit / 1000)}s (stuck at ${lastPercent}%).\n` +
        `Deadlock in the frame loop, the IPC pipe, or a seek that never resolved.`,
      );
    }

    if (Date.now() > deadline) {
      throw new Error(`export exceeded its ceiling at ${lastPercent}%`);
    }

    await page.waitForTimeout(500);
  }
}

async function waitForTerminalEvent(page: Page, timeoutMs: number): Promise<RenderEvent | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const events = await renderEvents(page);
    const terminal = events.find(
      (e) => e.kind === "finish" || e.kind === "v2Error" || e.kind === "v2Cancelled" || e.kind === "legacyError",
    );
    if (terminal != null) return terminal;
    await page.waitForTimeout(500);
  }
  return null;
}

/**
 * The UI's own account of how the export ended.
 *
 * Separate from `runExport`'s return value on purpose: one says what the main
 * process reported, the other says what the user was shown, and a divergence
 * between them is itself a bug worth failing on.
 */
/**
 * Dismiss the "Rendering is complete" dialog.
 *
 * It is a Bootstrap modal, so its backdrop sits over the whole window — the
 * title bar's export button included. A second export cannot be clicked until
 * it is closed, which is true for a user as well as for a spec.
 */
export async function dismissExportModals(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const id of ["progressFinish", "progressError"]) {
      const el = document.querySelector(`#${id}`);
      if (el == null) continue;
      (globalThis as any).bootstrap?.Modal?.getInstance?.(el)?.hide();
    }
  });
  await page
    .locator(".modal-backdrop")
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => {});
}

export async function exportModalState(page: Page): Promise<{
  finishVisible: boolean;
  errorVisible: boolean;
  errorMessage: string;
}> {
  return page.evaluate(() => {
    const shown = (id: string) => {
      const el = document.querySelector(`#${id}`) as HTMLElement | null;
      return el != null && el.classList.contains("show");
    };
    // No `progressVisible`: the render dialog is gone, and progress is the
    // title bar's ring.
    return {
      finishVisible: shown("progressFinish"),
      errorVisible: shown("progressError"),
      errorMessage: (document.querySelector("#progressErrorMsg")?.textContent ?? "").trim(),
    };
  });
}
