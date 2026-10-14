/**
 * Building a GIF's picture frame by frame, over a narrow port.
 *
 * A GIF frame is rarely the whole picture. An encoder stores only the
 * rectangle that changed and says what to do with it before the next frame
 * (its disposal), so frame 7 is frames 0 to 7 laid on top of each other with
 * the disposals applied in between. Of the 59 frames in Noto's animated 😂,
 * 58 are such patches. Drawing a patch as if it were the picture, stretched to
 * the clip's box, is what made a GIF jump and squash.
 *
 * The rule lives here rather than in `renderer/gif.ts` so it runs under
 * `environment: "node"` against a fake port; the renderer supplies a canvas.
 *
 * Disposal, from the GIF89a spec:
 *   0, 1  leave the frame where it is
 *   2     clear the frame's rectangle to transparent (what browsers do for
 *         "restore to background")
 *   3     put back what was under the frame before it was drawn
 * Anything else is treated as 0, as browsers do.
 */

export type GifRect = { left: number; top: number; width: number; height: number };

export type GifFrameInfo = {
  rect: GifRect;
  disposal: number;
};

export type GifComposePort<Snapshot> = {
  /** Clear the whole picture to transparent. */
  clearAll(): void;
  clearRect(rect: GifRect): void;
  /** Draw frame `index`'s patch at its rectangle, over what is there. */
  drawFrame(index: number): void;
  save(rect: GifRect): Snapshot;
  restore(snapshot: Snapshot, rect: GifRect): void;
};

export type GifComposeState<Snapshot> = {
  /** The frame the picture currently shows; -1 for a cleared picture. */
  index: number;
  /** What was under frame `index`, kept only when its disposal is 3. */
  saved: Snapshot | null;
};

export function emptyComposeState<Snapshot>(): GifComposeState<Snapshot> {
  return { index: -1, saved: null };
}

const RESTORE_BACKGROUND = 2;
const RESTORE_PREVIOUS = 3;

/**
 * Bring the picture to frame `target`, returning the new state.
 *
 * Forward from where it is, which is the whole cost during playback and an
 * export: one patch per frame. Backward (a scrub, or the loop wrapping) starts
 * again from a cleared picture, since a disposal cannot be undone; that is at
 * most one `drawImage` per frame of the GIF.
 */
export function composeTo<Snapshot>(
  state: GifComposeState<Snapshot>,
  frames: readonly GifFrameInfo[],
  target: number,
  port: GifComposePort<Snapshot>,
): GifComposeState<Snapshot> {
  if (target < 0 || target >= frames.length) {
    return state;
  }
  if (target === state.index) {
    return state;
  }

  let index = state.index;
  let saved = state.saved;
  if (index < 0 || index >= frames.length || target < index) {
    port.clearAll();
    index = -1;
    saved = null;
  }

  for (let next = index + 1; next <= target; next++) {
    if (next > 0) {
      const shown = frames[next - 1];
      if (shown.disposal === RESTORE_BACKGROUND) {
        port.clearRect(shown.rect);
      } else if (shown.disposal === RESTORE_PREVIOUS && saved != null) {
        port.restore(saved, shown.rect);
      }
    }
    const frame = frames[next];
    saved = frame.disposal === RESTORE_PREVIOUS ? port.save(frame.rect) : null;
    port.drawFrame(next);
  }

  return { index: target, saved };
}
