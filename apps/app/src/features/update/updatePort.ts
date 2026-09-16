/**
 * The preload bridge for the update card, narrowed to what the card uses.
 *
 * A plain record, as `ttsPort.ts` is, so the card's rules can be read without
 * a main process. Main's end is `electron/lib/autoUpdater.ts`.
 */

import type { UpdateEvent } from "./updateView";

export type UpdatePort = {
  /** The last event main sent, or `null` if there has been none. */
  getState(): Promise<UpdateEvent | null>;
  download(): Promise<void>;
  /** `false` if the update was not ready to install. */
  install(): Promise<boolean>;
  onEvent(handler: (event: UpdateEvent) => void): () => void;
};

/** The bridge, or `null` in the web build, which has no updater. */
export function updateBridge(): UpdatePort | null {
  return (window as any).electronAPI?.req?.update ?? null;
}
