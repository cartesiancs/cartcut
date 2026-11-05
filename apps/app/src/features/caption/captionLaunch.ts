/**
 * A request to caption particular clips, carried from the timeline's context
 * menu to the caption panel.
 *
 * The panel usually does not exist when the request is made: opening the
 * window is a write to `windowStore`, and Lit mounts `<automatic-caption>` on
 * a later update. So the request waits here, and the panel takes it when it
 * mounts, or at once through `subscribe` when it is already open. A port
 * rather than a store read, for the reason the panel's `timelineSelection` is
 * one: the panel does not read the app's stores.
 */

export type CaptionLaunchPort = {
  /**
   * The pending request, removed as it is read, so one click starts at most
   * one run. Null when nothing is pending.
   */
  take(): readonly string[] | null;
  /** Called when a request arrives. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
};

export type CaptionLaunch = CaptionLaunchPort & {
  /** Replace any pending request with these element keys. */
  request(keys: readonly string[]): void;
};

export function createCaptionLaunch(): CaptionLaunch {
  let pending: readonly string[] | null = null;
  const listeners = new Set<() => void>();

  return {
    request(keys) {
      pending = [...keys];
      for (const listener of [...listeners]) {
        listener();
      }
    },
    take() {
      const keys = pending;
      pending = null;
      return keys;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The one the context menu writes and the panel reads. */
export const captionLaunch = createCaptionLaunch();

/**
 * Whether captioning can run here. The web build has no transcription bridge,
 * so the menu row is left off rather than opening a panel that can only fail:
 * the rule `reverseSession.canReverseHere` keeps for the same reason.
 */
export function canCaptionHere(): boolean {
  return (globalThis as any).window?.electronAPI?.req?.transcribe != null;
}
