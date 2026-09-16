/**
 * What the update card shows, as pure functions of what main last said.
 *
 * Main owns the state machine (`electron/lib/updateSession.ts`) and sends one
 * `UpdateEvent` per change; this side only turns the latest one into a card.
 * The event type is a copy, because `electron/` may not import from here and
 * this may not import from there.
 */

export type UpdateEvent =
  | { kind: "available"; version: string }
  | { kind: "progress"; version: string; percent: number }
  | { kind: "preparing"; version: string }
  | { kind: "downloaded"; version: string }
  | { kind: "failed"; version: string; message: string };

export type UpdateView =
  | { phase: "hidden" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; percent: number }
  | { phase: "preparing"; version: string }
  | { phase: "ready"; version: string }
  | { phase: "failed"; version: string; message: string };

export const HIDDEN_UPDATE: UpdateView = { phase: "hidden" };

/**
 * The card after `event`.
 *
 * Returns `view` itself when nothing changes, or when `event` is not one
 * main could have sent: the renderer takes this over IPC, typed `any`.
 */
export function reduceUpdate(view: UpdateView, event: unknown): UpdateView {
  const next = viewOf(event);
  if (next == null || sameView(view, next)) {
    return view;
  }
  return next;
}

function viewOf(event: unknown): UpdateView | null {
  if (event == null || typeof event !== "object") {
    return null;
  }
  const { kind, version } = event as { kind?: unknown; version?: unknown };
  if (typeof version !== "string") {
    return null;
  }
  switch (kind) {
    case "available":
      return { phase: "available", version };
    case "progress": {
      const percent = (event as { percent?: unknown }).percent;
      if (typeof percent !== "number" || !Number.isFinite(percent)) {
        return null;
      }
      return {
        phase: "downloading",
        version,
        percent: Math.min(100, Math.max(0, Math.floor(percent))),
      };
    }
    case "preparing":
      return { phase: "preparing", version };
    case "downloaded":
      return { phase: "ready", version };
    case "failed": {
      const message = (event as { message?: unknown }).message;
      return {
        phase: "failed",
        version,
        message: typeof message === "string" ? message : "",
      };
    }
    default:
      return null;
  }
}

function sameView(a: UpdateView, b: UpdateView): boolean {
  if (a.phase !== b.phase) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return (
    left.version === right.version &&
    left.percent === right.percent &&
    left.message === right.message
  );
}

export type UpdateAction = "download" | "install";

export type UpdatePrompt = {
  /** Locale keys, under `update.` */
  messageKey: string;
  buttonKey: string;
  /** What the one button does, or `null` while it is disabled. */
  action: UpdateAction | null;
  /**
   * The bar: `null` for none, `"indeterminate"` while Squirrel checks the
   * download and reports nothing, otherwise a whole percent.
   */
  progress: number | "indeterminate" | null;
};

/** The card's contents for `view`, or `null` when there is no card. */
export function promptOf(view: UpdateView): UpdatePrompt | null {
  switch (view.phase) {
    case "hidden":
      return null;
    case "available":
      return {
        messageKey: "update.available",
        buttonKey: "update.download",
        action: "download",
        progress: null,
      };
    case "downloading":
      return {
        messageKey: "update.downloading",
        buttonKey: "update.download",
        action: null,
        progress: view.percent,
      };
    case "preparing":
      return {
        messageKey: "update.preparing",
        buttonKey: "update.restart",
        action: null,
        progress: "indeterminate",
      };
    case "ready":
      return {
        messageKey: "update.ready",
        buttonKey: "update.restart",
        action: "install",
        progress: 100,
      };
    case "failed":
      return {
        messageKey: "update.failed",
        buttonKey: "update.retry",
        action: "download",
        progress: null,
      };
  }
}

/**
 * Whether to go ahead with a restart. Asks only when there is unsaved work,
 * since the restart does not stop to offer a save.
 */
export function shouldInstall(dirty: boolean, confirm: () => boolean): boolean {
  return !dirty || confirm();
}
