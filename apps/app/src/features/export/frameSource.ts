/**
 * Where an export's video frames come from, and where its finished frames go.
 *
 * The frame loop (`renderTimeline.ts`) is one loop for both exports, so the
 * picture stays the preview's by construction. These two ports are the only
 * places they differ:
 *
 *   - the desktop export decodes with `<video>` seeks and hands raw RGBA to
 *     FFmpeg over IPC (the defaults below, unchanged);
 *   - the browser export decodes with WebCodecs (`webMedia/webFrameSource.ts`)
 *     and encodes the canvas directly (`web/webExportSession.ts`).
 */

import type { Timeline } from "../../@types/timeline";
import type { ILoadedAssetStore } from "../asset/loadedAssetStore";
import type { VideoScope } from "../asset/videoScope";

export type ExportFrameSource = {
  /** Open a decoder for every video clip in `assets`, into `scope`. */
  load(scope: VideoScope, assets: Timeline): Promise<void>;
  /** Place every clip visible at `timeMs` on its frame, and wait until it is there. */
  advance(scope: VideoScope, assets: Timeline, timeMs: number, fps: number): Promise<void>;
  /** Release every decoder `load` opened. Runs on success, failure and cancel. */
  release(scope: VideoScope): void | Promise<void>;
};

/** The desktop export's decoders: the scope's own `<video>` handles. */
export function videoElementFrameSource(
  assetStore: ILoadedAssetStore,
): ExportFrameSource {
  return {
    load: (scope, assets) => assetStore.loadExportScope(scope, assets),
    advance: (scope, assets, timeMs, fps) =>
      assetStore.seekScope(scope, assets, timeMs, fps),
    release: (scope) => assetStore.releaseVideoScope(scope),
  };
}
