import { createStore } from "zustand/vanilla";

/**
 * How many media files are being read for their metadata right now.
 *
 * Probing a video costs an IPC round trip to ffprobe on top of the `<video>`
 * element's own decode, so it is slow enough to need saying. It used to be said
 * with a modal-ish bootstrap toast in the middle of the screen
 * (`loadMetadataToast`), which covered the picture to report something nobody
 * has to act on; it is now the progress bar in `element-timeline-bottom`.
 *
 * A count rather than a flag: dropping ten files starts ten probes, and a flag
 * would be cleared by the first one to finish while nine were still running.
 */
export interface IMediaLoadStore {
  /** In-flight probes. Zero means nothing is loading. */
  pending: number;
  begin: () => void;
  end: () => void;
}

export const mediaLoadStore = createStore<IMediaLoadStore>((set, get) => ({
  pending: 0,

  begin: () => set({ pending: get().pending + 1 }),

  /**
   * Declines at zero rather than clamping, because zustand notifies every
   * subscriber on any `set` — including one that writes the value already
   * there.
   */
  end: () => {
    const { pending } = get();
    if (pending === 0) {
      return;
    }
    set({ pending: pending - 1 });
  },
}));

/** Run `work` with the indicator up, and take it down however it ends. */
export async function whileLoadingMedia<T>(work: () => Promise<T>): Promise<T> {
  mediaLoadStore.getState().begin();
  try {
    return await work();
  } finally {
    mediaLoadStore.getState().end();
  }
}
