/**
 * Everything outside the timeline store that follows the timeline being edited.
 *
 * The timeline store decides which timeline is active, and changes it for
 * several reasons: a tab, an Expand, closing a tab, an undo that lands on
 * main because the template it was in no longer exists, a load. Whatever the
 * reason, the same things have to follow, so they follow from the change
 * itself rather than from each path that can cause one. That is the rule that
 * keeps a switch from leaving half the editor in the other timeline.
 *
 * The store's own share (the playhead, zoom and scroll of each timeline, and
 * stopping playback and dropping the modal tool) happens inside the same `set`
 * as the switch: see `timelineStore.ts#viewSwap` for why it cannot be done
 * from here. What is left is in other stores, and happens here:
 *
 *  1. **The playback loop stops.** `isPlay` is already false, but the loop in
 *     `<element-control>` runs on `requestAnimationFrame` and only stops when
 *     told to; left running it would go on moving the new timeline's
 *     playhead.
 *  2. **The selection, the keyframe target and the text range are cleared,**
 *     and the option column emptied: each names elements of the timeline
 *     being left.
 *  3. **The frame being edited becomes the composition's.** The project's own
 *     size is kept in `mainFrame.ts` and comes back with main.
 *  4. **The preview's pan and zoom are kept per timeline**, and a timeline
 *     seen for the first time is fitted. The pan is in the frame's own
 *     pixels, so carried across it would point at nothing.
 *
 * Nothing here writes the timeline store. Over a port, so every rule above
 * runs in the `node` suite against a fake.
 */

import { MAIN_TIMELINE, type CompositionMeta } from "./project";
import { parkedMainFrame, setParkedMainFrame } from "./mainFrame";

export type FrameSize = { w: number; h: number };

export type SwitchPort = {
  stopPlayback(): void;
  /** Selection, keyframe target, text range, and the option column. */
  clearSelection(): void;
  readFrame(): FrameSize;
  writeFrame(frame: FrameSize): void;
  /** The preview's pan and zoom, opaque here. */
  readViewport(): unknown;
  /** `null` fits the preview to `frame`. */
  writeViewport(viewport: unknown | null, frame: FrameSize): void;
};

/** The part of the timeline store's state this reads. */
export type SwitchSource = {
  activeTimelineId: string;
  projectEpoch: number;
  compositions: Record<string, CompositionMeta>;
};

export type SwitchEffects = {
  /** Every new store state. Acts only when the active timeline or the project changed. */
  observe(state: SwitchSource): void;
};

export function createSwitchEffects(
  port: SwitchPort,
  initial: SwitchSource,
): SwitchEffects {
  let active = initial.activeTimelineId;
  let epoch = initial.projectEpoch;
  let viewports = new Map<string, unknown>();

  function frameOf(state: SwitchSource, timelineId: string): FrameSize | null {
    if (timelineId === MAIN_TIMELINE) {
      return parkedMainFrame();
    }
    const size = state.compositions[timelineId]?.size;
    return size == null ? null : { w: size.w, h: size.h };
  }

  function switchTo(state: SwitchSource, from: string, to: string): void {
    port.stopPlayback();
    port.clearSelection();

    viewports.set(from, port.readViewport());

    if (from === MAIN_TIMELINE) {
      setParkedMainFrame(port.readFrame());
    }
    const frame = frameOf(state, to) ?? port.readFrame();
    port.writeFrame({ w: frame.w, h: frame.h });
    if (to === MAIN_TIMELINE) {
      setParkedMainFrame(null);
    }

    port.writeViewport(viewports.get(to) ?? null, frame);
    viewports.delete(to);
  }

  return {
    observe(state) {
      const changedProject = state.projectEpoch !== epoch;
      const from = active;
      const to = state.activeTimelineId;
      epoch = state.projectEpoch;
      active = to;

      if (from !== to) {
        switchTo(state, from, to);
      }
      if (changedProject) {
        // A clear or a load: no timeline of the old project comes back, and
        // the frame in the render options is the project's own again.
        viewports = new Map();
        if (to === MAIN_TIMELINE) {
          setParkedMainFrame(null);
        }
      }
    },
  };
}
