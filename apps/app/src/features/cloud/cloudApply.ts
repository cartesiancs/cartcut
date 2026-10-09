/**
 * Clicking a cloud tile: download, then do what a local tile's click does.
 *
 * **The latest click wins.** A download takes seconds, and a user who clicks
 * a second tile in that time means the second one. Each grid keeps a
 * `ClickOrder`; every click (local or cloud) takes the next number, and a
 * download that lands applies only if its number is still the latest. The
 * download itself is never abandoned: it finishes and installs, so the next
 * click on that tile is instant.
 *
 * The apply runs against the timeline and the selection **as they are when the
 * download lands**, which is what the user is looking at by then.
 */

import { downloadCloudItem } from "./cloudStore";
import type { CloudDownloadOutcome, CloudKind } from "./cloudTypes";

export type ClickOrder = {
  /** Take a number for a click. */
  next: () => number;
  isLatest: (token: number) => boolean;
};

export function createClickOrder(): ClickOrder {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (token) => token === latest,
  };
}

/** What to tell the user about a download that did not install, or `null`. */
export function describeCloudFailure(outcome: CloudDownloadOutcome, name: string): string | null {
  if (outcome.ok) {
    return null;
  }
  switch (outcome.reason) {
    case "cancelled":
      return null;
    case "offline":
      return "You are offline. Cloud items need a connection to download.";
    case "disabled":
      return "Cloud content is turned off in Settings.";
    case "unreachable":
      return "The cloud server could not be reached.";
    case "missing":
      return `${name} is no longer offered.`;
    default:
      return outcome.message == null || outcome.message === ""
        ? `${name} could not be downloaded.`
        : `${name} could not be downloaded: ${outcome.message}`;
  }
}

export function toast(message: string): void {
  (document.querySelector("toast-box") as any)?.showToast({ message, delay: "4000" });
}

export type InstallSteps = {
  /**
   * Re-read whatever registry the item installs into. Runs after every
   * successful download, latest click or not: skipping it would leave a
   * downloaded tile looking undownloaded, and the next click would fetch it
   * again.
   */
  reload: () => Promise<void>;
  /** What the local tile's click does. Runs only for the latest click. */
  apply: (installedPath: string) => void | Promise<void>;
};

/**
 * Download one item for a click holding `token`, reload, then apply if that
 * click is still the latest. Failures are toasted whatever the order,
 * because a download that failed is news either way.
 */
export async function downloadThenApply(
  order: ClickOrder,
  token: number,
  kind: CloudKind,
  id: string,
  name: string,
  steps: InstallSteps,
): Promise<void> {
  const outcome = await downloadCloudItem(kind, id);
  if (!outcome.ok) {
    const message = describeCloudFailure(outcome, name);
    if (message != null) {
      toast(message);
    }
    return;
  }
  await steps.reload();
  if (!order.isLatest(token)) {
    return;
  }
  await steps.apply(outcome.path);
}
