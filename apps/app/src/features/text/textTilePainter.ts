/**
 * Draws Text panel tiles: the DOM half of `textTile.ts`.
 *
 * A tile is composited by `renderTimelineAtTime`, the function the preview,
 * the export and the contact sheet all call, over a one-clip map, under a
 * transform that crops the frame to the text. Text is drawn synchronously on a
 * 2D canvas and costs well under a millisecond here, so there is no bitmap
 * cache and no render queue the way `fx/fxPreviewProvider.ts` needs for WebGL:
 * the tile's own canvas holds its resting frame, and a hovered tile is simply
 * drawn again on every display frame.
 *
 * The one thing the canvas will not do for it is wait for a face. A canvas
 * given a family that has not loaded draws in the fallback and says nothing,
 * and nothing redraws it when the face arrives. So each family is loaded
 * before its first tile is drawn (`font/fontFaces.ts#faceReady`), the way
 * `graphic/htmlHost.ts` waits for a graphic's fonts, and a crop is only
 * measured after that, since the fallback has other widths. The frame itself is `textTileDraw.ts`.
 */

import { exportElementRenderers } from "../export/renderers";
import { DEFAULT_FONT, faceReady, type FontEntry } from "../font/fontFaces";
import { windowScheduler, type FrameScheduler } from "../caption/previewLoop";
import { loopClipTime, type TileSpec, type TileView } from "./textTile";
import { drawTile as drawTileWith, measureTileView } from "./textTileDraw";

/** The panel draws with the export's own renderers, as every composite does. */
function drawTile(
  canvas: HTMLCanvasElement,
  spec: TileSpec,
  view: TileView,
  timeMs: number,
): void {
  drawTileWith(canvas, spec, view, timeMs, exportElementRenderers);
}

/** The face a tile's clip is set in, as `ensureFontFace` wants it. */
export function faceOf(spec: TileSpec): FontEntry {
  const { fontpath, fontname, fonttype } = spec.element;
  return fontpath === DEFAULT_FONT.path || !fontpath
    ? DEFAULT_FONT
    : { path: fontpath, name: fontname, type: fonttype };
}

/** What a canvas was last asked to show; `view` waits for the face. */
type Drawn = { spec: TileSpec; view: TileView | null };

/**
 * The panel's painter: resting frames on demand, and one loop for whichever
 * animated tile the pointer is over.
 *
 * The scheduler is a port (`caption/previewLoop.ts#FrameScheduler`) so the
 * loop's bookkeeping is the same code under a fake clock.
 */
export class TextTilePainter {
  private drawn = new WeakMap<HTMLCanvasElement, Drawn>();
  private playing: { canvas: HTMLCanvasElement; startedAt: number } | null = null;
  private frame = 0;

  constructor(
    private readonly scheduler: FrameScheduler = windowScheduler(),
    private readonly now: () => number = () => performance.now(),
  ) {}

  /**
   * Draw `spec`'s resting frame into `canvas` once its face is ready.
   *
   * A later call for the same canvas wins: a search that reuses the canvas,
   * or a frame-size change, must not be overwritten by an older draw whose
   * font happened to arrive last.
   */
  async rest(canvas: HTMLCanvasElement, spec: TileSpec): Promise<void> {
    this.drawn.set(canvas, { spec, view: null });
    await faceReady(faceOf(spec));
    const current = this.drawn.get(canvas);
    if (current?.spec !== spec) {
      return;
    }
    const view = measureTileView(canvas, spec.element);
    if (view == null) {
      return;
    }
    current.view = view;
    if (this.playing?.canvas !== canvas) {
      drawTile(canvas, spec, view, spec.restMs);
    }
  }

  /** Start the loop on `canvas`, stopping whichever tile played before. */
  play(canvas: HTMLCanvasElement): void {
    const drawn = this.drawn.get(canvas);
    if (drawn?.spec.loop == null) {
      return;
    }
    if (this.playing?.canvas === canvas) {
      return;
    }
    this.stop();
    this.playing = { canvas, startedAt: this.now() };
    this.tick();
  }

  /** Stop the loop, putting its tile back on its resting frame. */
  stop(canvas?: HTMLCanvasElement): void {
    const playing = this.playing;
    if (playing == null || (canvas != null && playing.canvas !== canvas)) {
      return;
    }
    this.playing = null;
    if (this.frame !== 0) {
      this.scheduler.cancel(this.frame);
      this.frame = 0;
    }
    const drawn = this.drawn.get(playing.canvas);
    if (drawn?.view != null) {
      drawTile(playing.canvas, drawn.spec, drawn.view, drawn.spec.restMs);
    }
  }

  /** Whether `canvas` is the tile the loop is drawing. */
  isPlaying(canvas: HTMLCanvasElement): boolean {
    return this.playing?.canvas === canvas;
  }

  dispose(): void {
    this.stop();
  }

  private tick = (): void => {
    this.frame = 0;
    const playing = this.playing;
    if (playing == null) {
      return;
    }
    // A tab hidden by Bootstrap's `.tab-pane` leaves the tile connected and
    // invisible; a loop drawing into it would run until the next hover.
    if (!playing.canvas.isConnected || playing.canvas.offsetParent == null) {
      this.stop();
      return;
    }
    const drawn = this.drawn.get(playing.canvas);
    if (drawn?.spec.loop != null && drawn.view != null) {
      const at = loopClipTime(drawn.spec.loop, this.now() - playing.startedAt);
      drawTile(playing.canvas, drawn.spec, drawn.view, at);
    }
    this.frame = this.scheduler.request(this.tick);
  };
}
