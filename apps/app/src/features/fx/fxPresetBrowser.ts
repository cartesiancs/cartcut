/**
 * The preset tile grid, shared by both kinds.
 *
 * One component with a `kind` property rather than two nearly identical ones:
 * an effect preset and a transition preset differ in what they attach to, not
 * in how they are browsed, and the tile, the thumbnail fallback and the
 * built-in/user split are all the same work.
 *
 * Clicking a tile applies the preset to the current selection when that makes
 * sense, and otherwise says why it does not — a tile that silently does nothing
 * is the worst outcome, and it is what happens if you only wire the happy path.
 *
 * Strings here are English and stay English, following `ControlText`: preset
 * names come from third-party manifests and are not translatable, so a
 * half-localised panel would read worse than a consistent one.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import { useTimelineStore } from "../../states/timelineStore";
import { selectionStore } from "../../states/selectionStore";
import {
  defaultParamsFor,
  loadPresets,
  presetsOfKind,
  type FxPreset,
} from "./presetRegistry";
import { categoriesFor } from "./presetTypes";
import { addEffect, setEffectPreset } from "../timeline/effectOps";
import {
  addTransition,
  cutPointsOn,
  setTransitionPreset,
} from "../timeline/transitionOps";
import { DEFAULT_TRANSITION_MS } from "../timeline/transitionGeometry";
import { DEFAULT_EFFECT_MS } from "../element/effectElement";
import { FX_PRESET_MIME } from "../asset/dropIntent";
import { subscribePresets } from "./presetRegistry";
import {
  PREVIEW_H,
  PREVIEW_STEPS,
  PREVIEW_W,
  RESTING_STEP,
  createFxPreviewProvider,
  previewKey,
} from "./fxPreviewProvider";

/**
 * One renderer for both browsers.
 *
 * Module-level rather than per-component because it owns a WebGL context, and
 * `ControlFx` mounts two of these panels at once — a context each would double
 * the cost for a cache they can share, since a preset id is the whole key.
 */
const previews = createFxPreviewProvider();

/**
 * Headings for the category enum.
 *
 * The enum values are code identifiers and stay as they are; these are what a
 * person reads. Anything absent falls back to the raw value, so adding a
 * category cannot produce a blank heading.
 */
const CATEGORY_LABELS: Record<string, string> = {
  dissolve: "Dissolve",
  wipe: "Wipe",
  slide: "Slide",
  zoom: "Zoom",
  distort: "Distort",
  pattern: "Pattern",
  "3d": "3D",
  light: "Light",
  color: "Colour",
  tone: "Tone",
  optical: "Optical",
  blur: "Blur",
  texture: "Texture",
  stylize: "Stylise",
};

function toast(message: string) {
  (document.querySelector("toast-box") as any)?.showToast({
    message,
    delay: "4000",
  });
}

@customElement("fx-preset-browser")
export class FxPresetBrowser extends LitElement {
  @property({ type: String })
  kind: "effect" | "transition" = "effect";

  /** The tile under the pointer, or `null`. Only this one animates. */
  private hoveredId: string | null = null;
  private hoverStep = RESTING_STEP;
  private hoverHandle = 0;
  /** Unsubscribes gathered at mount, run on teardown. */
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    // The grid reflects what is selected — a transition tile applies to the
    // selected transition if there is one — so it has to repaint on selection
    // and on document changes.
    // Kept so they can be released. These used to be subscribed and never
    // unsubscribed — harmless while the panel is never torn down, and a leak
    // the moment anything does tear it down.
    this.teardown.push(
      selectionStore.subscribe(() => this.requestUpdate()),
      useTimelineStore.subscribe(() => this.requestUpdate()),
      // A frame landing repaints the tiles that were waiting for it.
      previews.onReady(() => this.paintTiles()),
      subscribePresets(() => this.requestUpdate()),
    );

    // Or the timeline canvas's document-level mousedown clears the selection
    // before a tile's click handler runs, and every tile would act on nothing.
    this.setAttribute("data-keeps-selection", "");

    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // Presets are loaded once at startup by `App`; this only re-reads if that
    // has not happened yet or the user has just installed something.
    if (presetsOfKind(this.kind).length === 0) {
      void loadPresets().then(() => this.requestUpdate());
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.cancelHoverLoop();
    for (const release of this.teardown) {
      release();
    }
    this.teardown = [];
  }

  updated() {
    // Tiles are re-created whenever the list changes, so they start blank.
    this.paintTiles();
  }

  // ------------------------------------------------------------------ apply

  private applyEffect(preset: FxPreset) {
    const store = useTimelineStore.getState();
    const selected = selectionStore.getState().ids[0];
    const selectedElement = selected != null ? store.timeline[selected] : null;

    // An effect already selected changes preset in place — the obvious reading
    // of clicking a different tile while one is selected.
    if (selectedElement?.filetype === "effect") {
      store.withCheckpoint((doc) =>
        setEffectPreset(doc, selected, preset.id, defaultParamsFor(preset.id)),
      );
      return;
    }

    const id = uuidv4();
    const trackId = uuidv4();
    store.withCheckpoint((doc) =>
      addEffect(
        doc,
        id,
        preset.id,
        store.cursor,
        DEFAULT_EFFECT_MS,
        trackId,
        defaultParamsFor(preset.id),
        {
          blend:
            preset.render.type === "overlay"
              ? ((preset.render.blend as GlobalCompositeOperation) ?? "screen")
              : undefined,
        },
      ),
    );
    selectionStore.getState().setIds([id]);
  }

  private applyTransition(preset: FxPreset) {
    const store = useTimelineStore.getState();
    const selected = selectionStore.getState().ids[0];
    const selectedElement = selected != null ? store.timeline[selected] : null;

    if (selectedElement?.filetype === "transition") {
      store.withCheckpoint((doc) =>
        setTransitionPreset(
          doc,
          selected,
          preset.id,
          defaultParamsFor(preset.id),
        ),
      );
      return;
    }

    // Otherwise, the cut nearest the playhead on the selected clip's track.
    // Clicking a transition tile with a clip selected most likely means "put
    // one on this clip's cut", and guessing that is better than refusing.
    const doc = store.getDocument();
    const trackId = selectedElement?.trackId;
    if (trackId == null) {
      toast("Select a clip next to a cut, or click a cut on the timeline.");
      return;
    }

    const bare = cutPointsOn(doc, trackId).filter(
      (cut) => cut.transitionId == null,
    );
    if (bare.length === 0) {
      toast("No cut on this track to put a transition on.");
      return;
    }

    const nearest = bare.reduce((best, cut) =>
      Math.abs(cut.atMs - store.cursor) < Math.abs(best.atMs - store.cursor)
        ? cut
        : best,
    );

    const id = uuidv4();
    store.withCheckpoint((next) =>
      addTransition(
        next,
        id,
        nearest.fromId,
        nearest.toId,
        preset.id,
        DEFAULT_TRANSITION_MS,
        "center",
        defaultParamsFor(preset.id),
      ),
    );

    if (useTimelineStore.getState().timeline[id] == null) {
      toast("Those clips are too short to hold a transition.");
      return;
    }
    selectionStore.getState().setIds([id]);
  }

  private handleClick(preset: FxPreset) {
    if (this.kind === "effect") {
      this.applyEffect(preset);
    } else {
      this.applyTransition(preset);
    }
  }

  private handleDragStart(e: DragEvent, preset: FxPreset) {
    if (e.dataTransfer == null) {
      return;
    }
    e.dataTransfer.setData(FX_PRESET_MIME, preset.id);
    e.dataTransfer.effectAllowed = "copy";
  }

  // ----------------------------------------------------------------- render

  private tile(preset: FxPreset) {
    return html`
      <div
        class="col-6 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
        draggable="true"
        title=${preset.author != null
          ? preset.name + " — " + preset.author
          : preset.name}
        @click=${() => this.handleClick(preset)}
        @dragstart=${(e: DragEvent) => this.handleDragStart(e, preset)}
        @mouseenter=${() => this.startHover(preset.id)}
        @mouseleave=${() => this.stopHover(preset.id)}
      >
        <!--
          A live frame, rendered through the same compositor the timeline uses,
          so what the tile shows is what the preset actually does rather than an
          artist's impression of it. Pointer events are off because the parent
          owns the click and the drag.
        -->
        <canvas
          data-preset=${preset.id}
          width=${PREVIEW_W}
          height=${PREVIEW_H}
          style="width: 100%; aspect-ratio: 16/9; border-radius: 4px;
                 background: #2b2c33; display: block; pointer-events: none;"
        ></canvas>
        <span
          class="text-light"
          style="font-size: 11px; margin-top: 2px;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"
        >
          ${preset.name}
        </span>
      </div>
    `;
  }

  // ---------------------------------------------------------------- previews

  /**
   * Paint every tile from whatever the provider already has.
   *
   * Misses ask and draw nothing; the provider calls back when they land. That
   * is what lets a panel of seventy tiles appear at once instead of blocking on
   * seventy GL draws.
   */
  private paintTiles() {
    if (this.isHidden()) {
      return;
    }
    const canvases = this.querySelectorAll("canvas[data-preset]");
    for (const node of canvases) {
      const canvas = node as HTMLCanvasElement;
      const presetId = canvas.dataset.preset;
      if (presetId == null) {
        continue;
      }
      const step =
        presetId === this.hoveredId ? this.hoverStep : RESTING_STEP;
      const key = previewKey(presetId, step);
      const frame = previews.get(key);
      const ctx = canvas.getContext("2d");
      if (ctx == null) {
        continue;
      }
      if (frame == null) {
        previews.request({ key, presetId, step } as never);
        continue;
      }
      ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
      ctx.drawImage(frame, 0, 0, PREVIEW_W, PREVIEW_H);
    }
  }

  /**
   * Whether this browser is the one currently on screen.
   *
   * `ControlFx` keeps *both* browsers mounted and toggles `d-none` on their
   * wrappers, so `disconnectedCallback` never fires for either. Visibility, not
   * lifecycle, is what has to gate the animation loop — otherwise the hidden
   * tab keeps a rAF running for the life of the app.
   */
  private isHidden(): boolean {
    return this.closest(".d-none") != null;
  }

  private startHover(presetId: string) {
    if (this.hoveredId === presetId) {
      return;
    }
    this.hoveredId = presetId;
    this.hoverStep = 0;
    this.runHoverLoop();
  }

  private stopHover(presetId: string) {
    if (this.hoveredId !== presetId) {
      return;
    }
    this.hoveredId = null;
    this.cancelHoverLoop();
    this.paintTiles();
  }

  /**
   * Advance the hovered tile, and nothing else.
   *
   * One loop for the whole panel rather than one per tile: seventy simultaneous
   * loops would spend the frame budget on tiles nobody is looking at.
   */
  private runHoverLoop() {
    if (this.hoverHandle !== 0) {
      return;
    }
    const tick = () => {
      this.hoverHandle = 0;
      if (this.hoveredId == null || this.isHidden()) {
        return;
      }
      this.hoverStep = (this.hoverStep + 1) % PREVIEW_STEPS;
      this.paintTiles();
      // Ask for the next few steps early so the loop is not chasing the
      // renderer a frame at a time.
      for (let ahead = 1; ahead <= 3; ahead++) {
        const step = (this.hoverStep + ahead) % PREVIEW_STEPS;
        const key = previewKey(this.hoveredId, step);
        if (previews.get(key) == null) {
          previews.request({ key, presetId: this.hoveredId, step } as never);
        }
      }
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

  // ---------------------------------------------------------------- filtering

  /** Lower-cased search text. Empty means show everything. */
  private query = "";

  private handleSearch(e: Event) {
    this.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
    this.requestUpdate();
  }

  /**
   * Matched against name, category and author.
   *
   * Category is included so that typing "blur" finds the whole section, which
   * is how someone who knows what they want but not what it is called will
   * look for it.
   */
  // Not `matches` — `Element.matches(selectors)` already occupies that name,
  // and overriding it with an incompatible signature is a type error.
  private matchesQuery(preset: FxPreset): boolean {
    if (this.query === "") {
      return true;
    }
    const haystack = [
      preset.name,
      preset.category,
      CATEGORY_LABELS[preset.category] ?? "",
      preset.author ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(this.query);
  }

  render() {
    const matching = presetsOfKind(this.kind).filter((preset) =>
      this.matchesQuery(preset),
    );

    // Enum order, not alphabetical: the categories are arranged from the ones
    // people reach for most to the ones they reach for rarely, and sorting the
    // headings by name would throw that away. `presetsOfKind` has already put
    // built-ins ahead of user presets, and filtering preserves it, so within a
    // section that ordering still holds.
    const sections = categoriesFor(this.kind)
      .map((category) => ({
        category,
        presets: matching.filter((preset) => preset.category === category),
      }))
      .filter((section) => section.presets.length > 0);

    const total = presetsOfKind(this.kind).length;

    return html`
      <div class="px-2 pt-1">
        <input
          type="search"
          class="form-control form-control-sm bg-dark text-light border-secondary"
          style="font-size: 11px;"
          placeholder=${"Search " + total + " " + this.kind + "s"}
          @input=${(e: Event) => this.handleSearch(e)}
        />
      </div>

      ${total === 0
        ? html`<div class="text-secondary p-2" style="font-size: 11px;">
            No ${this.kind} presets installed.
          </div>`
        : sections.length === 0
          ? html`<div class="text-secondary p-2" style="font-size: 11px;">
              Nothing matches that.
            </div>`
          : sections.map(
              (section) => html`
                <div
                  class="text-secondary px-2 pt-2"
                  style="font-size: 10px; text-transform: uppercase;
                         letter-spacing: 0.06em;"
                >
                  ${CATEGORY_LABELS[section.category] ?? section.category}
                </div>
                <div class="row px-2">
                  ${section.presets.map((preset) => this.tile(preset))}
                </div>
              `,
            )}
    `;
  }
}
