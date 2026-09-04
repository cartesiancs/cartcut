/**
 * The animation preset grid, in a clip's inspector.
 *
 * Deliberately shaped like `fx/fxPresetBrowser.ts` and `lut/lutBrowser.ts` —
 * the same `.asset` tile, the same uppercase category headings, the same single
 * rAF loop that animates only the tile under the pointer — because a third grid
 * that browses alike should look alike. What differs is what a tile draws and
 * what a click does.
 *
 * **A click applies the preset at the playhead**, to every selected clip, as
 * one undo step. That is the After Effects arrangement rather than Premiere's:
 * the preset is a move, and where the move happens is wherever the user has
 * parked the cursor. `presets.ts#playheadAnchor` decides whether the playhead
 * is over a given clip at all; when it is not, the preset falls back to its own
 * anchor — the clip's start, or its end for an out preset — because a tile that
 * silently does nothing is the worst outcome a grid like this can have.
 *
 * ## The tiles show the real move
 *
 * Each thumbnail is drawn from `animation/presetPreview.ts#previewSamples`,
 * which runs the *actual* `applyPreset` and reads it back through the *actual*
 * `localSampleAt`. Nothing here restates what a preset does, so nothing here
 * can be edited into disagreeing with it. The same argument `fxPreviewProvider`
 * makes for rendering its thumbnails through the real compositor.
 *
 * Two things about the drawing that are easy to get wrong:
 *
 * - **The resting frame is step 0 with opacity ignored.** Step 0 is the pose a
 *   preset starts from, which is what makes Move Up sit low in its tile and
 *   Move Down sit high — the grid reads as a diagram before anything is
 *   hovered. Honouring opacity there would render `fade_in` as an empty square,
 *   so the resting frame shows the *pose* and the hover shows the *motion*.
 * - **Only "None" gets an active outline.** Unlike a LUT, an applied preset
 *   leaves no mark on the document: its keyframes are indistinguishable from
 *   ones drawn by hand. A highlight on Fade In would be a guess presented as a
 *   fact, so there is none, and "None" lights up on the one thing that *is*
 *   knowable — that the clip has no animation at all.
 *
 * Strings are English and stay English, following `fxPresetBrowser`,
 * `lutBrowser` and `ControlText`.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { clearAnimation, hasAnimation } from "../animation/keyframeOps";
import { bakeRateFor } from "../animation/keyframes";
import {
  PREVIEW_BOX,
  PREVIEW_STEPS,
  previewSamples,
  type PreviewSample,
} from "../animation/presetPreview";
import {
  applyPreset,
  playheadAnchor,
  presetDefaultMs,
  presetGroup,
  presetLabel,
  presetNames,
  type PresetGroup,
  type PresetName,
} from "../animation/presets";

/** Backing-store size of a tile canvas. Fixed, so nothing reallocates. */
const TILE_PX = 132;

/** Headings, in the order the panel shows them. */
const GROUPS: Array<{ id: PresetGroup; label: string }> = [
  { id: "in", label: "In" },
  { id: "out", label: "Out" },
  { id: "emphasis", label: "Emphasis" },
];

const TILE_BG = "#26272c";
const INK = "#f8f9fa";
const ACTIVE = "#4b8dff";

/**
 * How far one `PREVIEW_BOX` length is drawn as, in fractions of the tile.
 *
 * **The tile is a diagram, not a scale model**, and this is the one place that
 * is true. A slide travels exactly one box length, so drawing it to scale puts
 * the start of every slide precisely off the tile's own edge — measured on the
 * built tiles, Move Up and Move Down rendered completely empty and Move
 * Left/Right showed forty-odd pixels of ink at the rim. The reader needs to see
 * *which way* it goes, which needs both ends on the tile.
 *
 * 0.26 with `TILE_FONT` at 0.14 is the largest pair that keeps the whole word
 * inside the tile at both extremes of a horizontal slide, which is the tightest
 * of the eight: half a word is ~0.22 of the tile wide, and 0.5 − 0.26 − 0.22
 * still leaves room.
 *
 * Scale and rotation are *not* rescaled — those are already fractions of the
 * element and read correctly at any tile size.
 */
const TILE_TRAVEL = 0.26;

/** Font size of the sample word, in fractions of the tile. See `TILE_TRAVEL`. */
const TILE_FONT = 0.14;

/** Extra frames a hovered tile rests on before looping. */
const HOVER_HOLD = 10;

/** The id the "None" tile carries in `data-preset`. Not a `PresetName`. */
const NONE_ID = "__none__";

function toast(message: string) {
  (document.querySelector("toast-box") as any)?.showToast({
    message,
    delay: "4000",
  });
}

@customElement("animation-preset-browser")
export class AnimationPresetBrowser extends LitElement {
  /**
   * The clips a click acts on.
   *
   * An array because `option-text` is the one multi-select inspector; the other
   * three hand over a list of one.
   */
  @property({ attribute: false })
  elementIds: string[] = [];

  /** The tile under the pointer, or `null`. Only this one animates. */
  private hovered: PresetName | null = null;
  private hoverStep = 0;
  private hoverHandle = 0;
  private teardown: Array<() => void> = [];
  private visibility: IntersectionObserver | null = null;

  createRenderRoot() {
    // The "None" tile reflects whether the clip has any animation, so the grid
    // has to repaint when the document changes — including on its own edits,
    // and on undo.
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));

    // Or the timeline canvas's document-level mousedown clears the selection
    // before a tile's click handler runs, and every tile would act on nothing.
    this.setAttribute("data-keeps-selection", "");

    return this;
  }

  connectedCallback() {
    super.connectedCallback();

    // This pane is mounted inside a `d-none` sibling of the Media tab, so the
    // first `updated()` runs with the tiles hidden and paints nothing. Nothing
    // about this element changes when the tab is clicked, so Lit would never
    // ask again. The same gap `lutBrowser` closes, the same way.
    this.visibility = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          this.paintTiles();
        }
      },
      { threshold: 0 },
    );
    this.visibility.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelHoverLoop();
    this.visibility?.disconnect();
    this.visibility = null;
    for (const release of this.teardown) {
      release();
    }
    this.teardown = [];
  }

  updated() {
    // Tiles are re-created whenever the list changes, so they start blank.
    this.paintTiles();
  }

  private isHidden(): boolean {
    return this.closest(".d-none") != null || this.offsetParent == null;
  }

  // ------------------------------------------------------------------- apply

  /**
   * Apply a preset, or clear everything when `preset` is null.
   *
   * One `withCheckpoint` for the whole selection, so a preset dropped on six
   * captions is one press of Cmd+Z. The pure ops decline by identity, and
   * `withCheckpoint` reads that as "nothing happened" and records no step — so
   * the only thing left to do is say why nothing happened, rather than leave
   * the click looking broken.
   */
  private apply(preset: PresetName | null) {
    const ids = this.elementIds ?? [];
    if (ids.length === 0) {
      toast("Select a clip first.");
      return;
    }

    const store = useTimelineStore.getState();
    const cursor = store.cursor ?? 0;
    // The project's rate, not `bakeTrack`'s 60Hz default: in a 120fps project
    // the lanes are read by nearest-sample lookup, so a 60Hz bake hands two
    // consecutive frames the same value and the move runs at half speed.
    const bakeHz = bakeRateFor(renderOptionStore.getState().options.fps);

    let changed = false;
    store.withCheckpoint((doc) => {
      let next = doc;
      for (const id of ids) {
        next =
          preset == null
            ? clearAnimation(next, id, bakeHz)
            : applyPreset(next, id, preset, presetDefaultMs(preset), bakeHz, {
                // Per clip: one playhead meets a selection at a different
                // offset into each of them.
                startAtMs: playheadAnchor(doc.elements[id], cursor),
              });
      }
      changed = next !== doc;
      return next;
    });

    if (!changed) {
      toast(
        preset == null
          ? "Nothing to clear on this selection."
          : "Those clips cannot animate what that preset drives.",
      );
    }
  }

  // ---------------------------------------------------------------- previews

  /** Whether every selected clip is already free of animation. */
  private get isCleared(): boolean {
    const timeline = useTimelineStore.getState().timeline;
    const ids = this.elementIds ?? [];
    return ids.length > 0 && ids.every((id) => !hasAnimation(timeline[id]));
  }

  private startHover(preset: PresetName) {
    if (this.hovered === preset) {
      return;
    }
    this.hovered = preset;
    this.hoverStep = 0;
    this.runHoverLoop();
  }

  private stopHover(preset: PresetName) {
    if (this.hovered !== preset) {
      return;
    }
    this.hovered = null;
    this.cancelHoverLoop();
    this.paintTiles();
  }

  /**
   * Advance the hovered tile, and nothing else.
   *
   * One loop for the whole panel rather than one per tile — twenty simultaneous
   * loops would spend the frame budget redrawing tiles nobody is looking at.
   */
  private runHoverLoop() {
    if (this.hoverHandle !== 0) {
      return;
    }
    const tick = () => {
      this.hoverHandle = 0;
      if (this.hovered == null || this.isHidden()) {
        return;
      }
      // A short hold past the end before looping. Without it the move restarts
      // the instant it lands, and a preset whose whole point is that it settles
      // never appears to.
      this.hoverStep = (this.hoverStep + 1) % (PREVIEW_STEPS + HOVER_HOLD);
      this.paintTiles();
      this.hoverHandle = requestAnimationFrame(tick);
    };
    this.hoverHandle = requestAnimationFrame(tick);
  }

  private cancelHoverLoop() {
    if (this.hoverHandle !== 0) {
      cancelAnimationFrame(this.hoverHandle);
      this.hoverHandle = 0;
    }
  }

  private paintTiles() {
    if (this.isHidden()) {
      return;
    }
    for (const node of this.querySelectorAll("canvas[data-preset]")) {
      const canvas = node as HTMLCanvasElement;
      const id = canvas.dataset.preset;
      const ctx = canvas.getContext("2d");
      if (id == null || ctx == null) {
        continue;
      }
      if (id === NONE_ID) {
        drawNone(ctx);
        continue;
      }

      const preset = id as PresetName;
      const samples = previewSamples(preset);
      const hovering = this.hovered === preset;
      const step = hovering ? Math.min(this.hoverStep, PREVIEW_STEPS - 1) : 0;

      drawTile(ctx, samples[step], hovering);
    }
  }

  // ------------------------------------------------------------------ render

  private tile(
    id: string,
    label: string,
    active: boolean,
    onClick: () => void,
    hover?: PresetName,
  ) {
    return html`
      <div
        class="col-4 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
        title=${label}
        @click=${onClick}
        @mouseenter=${hover == null ? undefined : () => this.startHover(hover)}
        @mouseleave=${hover == null ? undefined : () => this.stopHover(hover)}
      >
        <canvas
          data-preset=${id}
          width=${TILE_PX}
          height=${TILE_PX}
          style="width: 100%; aspect-ratio: 1/1; border-radius: 14px;
                 background: ${TILE_BG}; display: block; pointer-events: none;
                 outline: ${active ? `2px solid ${ACTIVE}` : "none"};
                 outline-offset: -2px;"
        ></canvas>
        <!--
          Wrapped over two lines rather than ellipsed, which is where the other
          grids in this app stop.

          Three columns in an option pane that measures 148px leaves 36px of
          label under a tile, and every one of these names is longer than that.
          Ellipsing gave four adjacent tiles reading "Mov…" — the whole
          directional set, rendered indistinguishable. Two fixed lines fit
          "Move / Down" and keep the rows on a grid; break-word catches
          "Overshoot", the one name with no space to break at.

          No backticks anywhere in this comment: it is inside a lit template
          literal, and one would end the template.
        -->
        <span
          class=${active
            ? "text-primary text-center"
            : "text-light text-center"}
          style="font-size: 11px; line-height: 1.2; margin-top: 4px;
                 height: 2.4em; overflow: hidden; overflow-wrap: break-word;"
        >
          ${label}
        </span>
      </div>
    `;
  }

  render() {
    const names = presetNames();

    return html`
      ${GROUPS.map(
        (group) => html`
          <div
            class="text-secondary px-2 pt-2"
            style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;"
          >
            ${group.label}
          </div>
          <div class="row px-2">
            <!--
              "None" leads the In row rather than sitting in a row of its own.
              It is the absence of an entrance, the list it heads is the
              entrances, and a single tile on a line of three reads as a gap.
            -->
            ${group.id === "in"
              ? this.tile(NONE_ID, "None", this.isCleared, () =>
                  this.apply(null),
                )
              : ""}
            ${names
              .filter((name) => presetGroup(name) === group.id)
              .map((name) =>
                this.tile(
                  name,
                  presetLabel(name),
                  false,
                  () => this.apply(name),
                  name,
                ),
              )}
          </div>
        `,
      )}
    `;
  }
}

/**
 * One frame of a preset, as the word it moves.
 *
 * The sample's offsets are in `PREVIEW_BOX` units, so everything here is one
 * multiplication away from being resolution-independent — which is what lets
 * the tile be any size without the preview module knowing about it.
 */
function drawTile(
  ctx: CanvasRenderingContext2D,
  sample: PreviewSample | undefined,
  hovering: boolean,
): void {
  ctx.clearRect(0, 0, TILE_PX, TILE_PX);
  if (sample == null) {
    return;
  }

  const unit = (TILE_PX * TILE_TRAVEL) / PREVIEW_BOX;

  ctx.save();
  // The resting frame shows the pose, not the transparency: at step 0 a
  // `fade_in` is at zero opacity and its tile would be an empty square with a
  // label under it, indistinguishable from one that failed to paint.
  ctx.globalAlpha = hovering
    ? Math.max(0, Math.min(1, sample.opacity / 100))
    : 1;

  ctx.translate(TILE_PX / 2 + sample.x * unit, TILE_PX / 2 + sample.y * unit);
  ctx.rotate((sample.rotationDeg * Math.PI) / 180);
  ctx.scale(sample.scale, sample.scale);

  ctx.fillStyle = INK;
  ctx.font = `700 ${Math.round(TILE_PX * TILE_FONT)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("TITLE", 0, 0);

  ctx.restore();
}

/** The slashed circle from the design: no animation. */
function drawNone(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, TILE_PX, TILE_PX);

  const centre = TILE_PX / 2;
  const radius = TILE_PX * 0.22;

  ctx.save();
  ctx.lineCap = "round";

  ctx.strokeStyle = "#8b8d96";
  ctx.lineWidth = TILE_PX * 0.055;
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.stroke();

  // The slash overshoots the circle at both ends, as in the design — a stroke
  // that stops at the rim reads as a chord rather than a cancellation.
  const reach = radius * 1.35;
  ctx.strokeStyle = "#e2606f";
  ctx.lineWidth = TILE_PX * 0.04;
  ctx.beginPath();
  ctx.moveTo(centre - reach * 0.72, centre + reach * 0.72);
  ctx.lineTo(centre + reach * 0.72, centre - reach * 0.72);
  ctx.stroke();

  ctx.restore();
}
