/**
 * Clicking Render, and waiting the way a person would have to.
 *
 * The click is genuine: `dialog.showSaveDialog` is stubbed in the main process
 * (see `launch.ts`), so `ControlRender.handleClickRenderV2Button` runs exactly
 * as it does for a user — the project-folder gate, the existing-file removal,
 * the progress modal, the abort controller and the frame loop all included.
 *
 * Completion is taken from the IPC events, not from the modal. `PROCESSING_FINISH`
 * and `render:v2:error` are what the main process actually emits, and the second
 * exists precisely because FFmpeg can fail *after* the last frame is written —
 * a run that watched only the progress bar would call that a success. The modal
 * is checked too, but as a UI assertion rather than as the completion signal.
 *
 * The stall detector is the other half. An export that deadlocks — a pipe that
 * stops draining, a seek that never resolves — otherwise burns the whole test
 * timeout and reports "timed out" with no indication of where. Watching the
 * frame counter stop moving turns that into "no progress for 120s at frame
 * 8,412 of 18,000", which names the failure.
 */

import { expect, type Page } from "@playwright/test";

import type { AppSession } from "./launch";
import { openTab } from "./ui";

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
   * `remaining` is the countdown the user was actually reading. It is recorded
   * because the property that matters about it is a property of the *sequence*
   * — it must never increase — and a single reading cannot show that.
   */
  progress: Array<{ atMs: number; percent: number; remaining: string }>;
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
 * The frame loop's own counter, read off the progress bar the app maintains,
 * alongside the remaining-time line beside it.
 *
 * Both in one `evaluate` so they describe the same instant — and note that a
 * `null` percent does not reset the stall timer below, which is why `#progress`
 * must only ever carry a number. Everything else the dialog has to say goes to
 * `#remainingTime`.
 */
async function progressSample(
  page: Page,
): Promise<{ percent: number | null; remaining: string }> {
  return page.evaluate(() => {
    const bar = document.querySelector("#progress") as HTMLElement | null;
    const line = document.querySelector("#remainingTime") as HTMLElement | null;
    const remaining = (line?.textContent ?? "").trim();
    if (bar == null) return { percent: null, remaining };
    const value = Number((bar.textContent ?? "").trim().replace("%", ""));
    return { percent: Number.isFinite(value) ? value : null, remaining };
  });
}

/** Non-null exactly while `handleClickRenderV2Button` is inside its try block. */
async function exportRunning(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const panel: any = document.querySelector("control-ui-render");
    return panel?.exportController != null;
  });
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
  await openTab(page, "#nav-output");

  // The export refuses outright while `#projectFolder` is empty, and does it
  // with a toast rather than an exception — which would otherwise look like an
  // export that finished instantly.
  const projectFolder = await page.locator("#projectFolder").inputValue();
  expect(projectFolder, "a project folder must be set before Render — see setProjectFolder()").not.toBe("");

  await session.answerSaveDialog(options.destination);

  const startedAt = Date.now();
  const renderButton = page.locator("control-ui-render button.btn-blue-fill", { hasText: "Render" });
  await expect(renderButton).toBeVisible();
  await renderButton.click();

  // The click resolves as soon as the handler yields at its first await, so the
  // export is still starting here.
  const progress: ExportOutcome["progress"] = [];
  let lastPercent = -1;
  let lastRemaining = "";
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

    const { percent, remaining } = await progressSample(page);
    if (percent != null && (percent !== lastPercent || remaining !== lastRemaining)) {
      // Only the *bar* clears the stall timer. The countdown ticks once a
      // second on a timer of its own, by design — it keeps moving precisely
      // when the frame loop does not — so letting it reset `lastMoveAt` would
      // mean a wedged export never trips the detector again.
      if (percent !== lastPercent) {
        lastMoveAt = Date.now();
      }
      lastPercent = percent;
      lastRemaining = remaining;
      progress.push({ atMs: Date.now() - startedAt, percent, remaining });
      options.onProgress?.(percent);
    }

    // The frame loop can finish and hand off to FFmpeg's own flush, during
    // which nothing moves and `exportController` is already null. Only treat a
    // vanished controller as an end state once an event has had a chance to
    // arrive.
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
export async function exportModalState(page: Page): Promise<{
  progressVisible: boolean;
  finishVisible: boolean;
  errorVisible: boolean;
  errorMessage: string;
}> {
  return page.evaluate(() => {
    const shown = (id: string) => {
      const el = document.querySelector(`#${id}`) as HTMLElement | null;
      return el != null && el.classList.contains("show");
    };
    return {
      progressVisible: shown("progressRender"),
      finishVisible: shown("progressFinish"),
      errorVisible: shown("progressError"),
      errorMessage: (document.querySelector("#progressErrorMsg")?.textContent ?? "").trim(),
    };
  });
}
