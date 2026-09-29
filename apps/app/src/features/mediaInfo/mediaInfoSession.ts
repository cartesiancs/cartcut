/**
 * The Show Info dialog's edges: the IPC call, the photo measurement, Reveal
 * and the clipboard, each behind `MediaInfoPort` so the rules about them run
 * under node against a fake (`mediaInfoSession.test.ts`).
 *
 * `loadMediaInfo` never rejects. The dialog is already on screen when it runs,
 * and a probe that fails has to become a sentence in it rather than an
 * unhandled rejection and a dialog stuck on its placeholders.
 */

import type {
  MediaInfoFailure,
  MediaInfoResult,
} from "../../../../../electron/lib/mediaInfo";
import { domProber } from "../element/mediaProbe";
import type { InfoTarget, LoadedInfo, ShownSize } from "./mediaInfoView";

export type MediaInfoPort = {
  /** `media:info`. Answers a `MediaInfoResult`, or whatever arrives instead. */
  probe(fsPath: string): Promise<unknown>;
  /** A photo's size as Chromium decodes it, EXIF orientation applied. */
  imageSize(localpath: string): Promise<ShownSize>;
  reveal(fsPath: string): void;
  copy(text: string): Promise<void>;
};

type ElectronReq = {
  media?: { info?: (fsPath: string) => Promise<unknown> };
  filesystem?: { showItemInFolder?: (fsPath: string) => void };
};

function req(): ElectronReq | null {
  if (typeof window === "undefined") {
    return null;
  }
  return ((window as any).electronAPI?.req as ElectronReq | undefined) ?? null;
}

/**
 * Whether Show Info can work here. The web build has no ffprobe bridge, so the
 * menu rows are left off rather than opening a dialog that can only fail: the
 * rule `reverseSession.canReverseHere` keeps for the same reason.
 */
export function canShowMediaInfo(): boolean {
  return typeof req()?.media?.info === "function";
}

export function electronMediaInfoPort(): MediaInfoPort {
  return {
    probe: async (fsPath) => {
      const info = req()?.media?.info;
      return info == null ? undefined : info(fsPath);
    },
    imageSize: (localpath) => domProber.image(localpath),
    reveal: (fsPath) => req()?.filesystem?.showItemInFolder?.(fsPath),
    copy: (text) => navigator.clipboard.writeText(text),
  };
}

const FAILURES: readonly MediaInfoFailure[] = [
  "missing",
  "unreadable",
  "timeout",
  "invalid",
];

/**
 * The shape the view relies on, checked at the process boundary. Only what
 * would throw if wrong is checked: `audio` is mapped over, `video` is read
 * through. The numbers inside came from `parseProbe`, which types them.
 */
export function isMediaInfoResult(value: unknown): value is MediaInfoResult {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const answer = value as { ok?: unknown; reason?: unknown; info?: any };
  if (answer.ok === false) {
    return FAILURES.includes(answer.reason as MediaInfoFailure);
  }
  if (answer.ok !== true || answer.info == null || typeof answer.info !== "object") {
    return false;
  }
  const { video, audio } = answer.info;
  return (
    Array.isArray(audio) &&
    audio.every((stream: unknown) => stream != null && typeof stream === "object") &&
    (video === null || (video != null && typeof video === "object"))
  );
}

const UNREADABLE: MediaInfoResult = { ok: false, reason: "unreadable" };

async function probeSafely(port: MediaInfoPort, fsPath: string): Promise<MediaInfoResult> {
  try {
    const answer = await port.probe(fsPath);
    return isMediaInfoResult(answer) ? answer : UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

function usableSize(size: unknown): ShownSize | null {
  const { width, height } = (size ?? {}) as Partial<ShownSize>;
  return typeof width === "number" &&
    typeof height === "number" &&
    width > 0 &&
    height > 0 &&
    Number.isFinite(width) &&
    Number.isFinite(height)
    ? { width, height }
    : null;
}

/**
 * Measured only for a photo. A GIF has no EXIF orientation, so ffprobe's size
 * is already the shown one, and decoding it again here would fetch the whole
 * file. A failed measurement costs the Rotation row, never the dialog.
 */
async function measureSafely(port: MediaInfoPort, target: InfoTarget): Promise<ShownSize | null> {
  if (target.kind !== "image") {
    return null;
  }
  try {
    return usableSize(await port.imageSize(target.localpath));
  } catch {
    return null;
  }
}

export async function loadMediaInfo(
  port: MediaInfoPort,
  target: InfoTarget,
): Promise<LoadedInfo> {
  const [result, shown] = await Promise.all([
    probeSafely(port, target.fsPath),
    measureSafely(port, target),
  ]);
  return { result, shown };
}

type MediaInfoDialogLike = { open(target: InfoTarget): void };

/** Open the dialog, from a menu row. Typed structurally to keep no cycle. */
export function openMediaInfo(target: InfoTarget): void {
  (document.querySelector("media-info-dialog") as unknown as MediaInfoDialogLike | null)?.open(
    target,
  );
}
