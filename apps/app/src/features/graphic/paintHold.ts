/**
 * Keeping the editor window painting while something waits on graphics.
 *
 * An HTML graphic reaches a raster only after Chromium paints it, and a window
 * sitting behind another one (or minimised) with background throttling on
 * paints nothing at all: every prepare runs out its timeout and no graphic is
 * drawn. The export always turned throttling off for its length. A contact
 * sheet and a program's filmstrip did not, so an agent checking its work while
 * the editor sat behind its terminal was shown every graphic missing (measured:
 * a three-frame sheet lost every title and a whole diagram), and went on to
 * rewrite graphics that were fine.
 *
 * Counted, because an export and a contact sheet can overlap: throttling comes
 * back only when the last hold is released, and a release is idempotent. Over a
 * port, so the counting is tested without Electron.
 */

export type ThrottlingPort = (allowed: boolean) => Promise<unknown> | unknown;

export type PaintHold = {
  /** Keep the window painting until the returned release is called. */
  hold(): Promise<() => Promise<void>>;
  readonly holders: number;
};

export function createPaintHold(setThrottling: ThrottlingPort): PaintHold {
  let holders = 0;
  const set = async (allowed: boolean) => {
    try {
      await setThrottling(allowed);
    } catch {
      // Throttling stays as it was; a prepare then reports the paint that never came.
    }
  };
  return {
    async hold() {
      holders += 1;
      if (holders === 1) {
        await set(false);
      }
      let released = false;
      return async () => {
        if (released) {
          return;
        }
        released = true;
        holders = Math.max(0, holders - 1);
        if (holders === 0) {
          await set(true);
        }
      };
    },
    get holders() {
      return holders;
    },
  };
}

/** The editor window's own throttling, through the preload bridge. A no-op where there is none. */
export const paintHold = createPaintHold((allowed) =>
  (globalThis as any)?.electronAPI?.req?.editor?.setBackgroundThrottling?.(allowed),
);
