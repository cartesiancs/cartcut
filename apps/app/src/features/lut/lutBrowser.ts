/**
 * The LUT panel's tile grid.
 *
 * Deliberately shaped like `fx/fxPresetBrowser.ts` — same tile markup, same
 * `.asset` hover, same search box, same uppercase category headings in enum
 * order — because it sits one tab away from it and two grids that browse alike
 * should look alike. What differs is what a click *does*, and that is the whole
 * design of the feature:
 *
 * | gesture | result |
 * |---|---|
 * | click with clips selected | grade every one of them, in a single undo step |
 * | click with nothing selected | an adjustment layer at the playhead |
 * | drag onto a clip | grade that clip |
 * | drag onto empty track space | an adjustment layer there |
 *
 * That is the Premiere and Final Cut arrangement: grade the shot you mean, or
 * grade the stack. Both routes end at the same preset id, because a LUT preset
 * is a LUT preset whether a clip or an effect element points at it.
 *
 * Strings here are English and stay English, following `ControlText` and
 * `fxPresetBrowser`: preset names come from manifests and are not translatable,
 * so a half-localised panel would read worse than a consistent one.
 */

import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";

import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { LUT_PRESET_MIME } from "../asset/dropIntent";
import { DEFAULT_EFFECT_MS } from "../element/effectElement";
import {
  loadPresets,
  presetsOfKind,
  subscribePresets,
  type FxPreset,
} from "../fx/presetRegistry";
import { LUT_CATEGORIES } from "../fx/presetTypes";
import { addEffect } from "../timeline/effectOps";
import { isGradable, setClipLutMany } from "../timeline/lutOps";
import { lutOf } from "../renderer/lut";
import { importLutFile, pickAndImportLut } from "./lutImport";
import { lutFailures, lutFor, loadLut } from "./lutRegistry";
import {
  LUT_PREVIEW_H,
  LUT_PREVIEW_W,
  createLutPreviewProvider,
} from "./lutPreviewProvider";

/**
 * One provider for the panel.
 *
 * Module-level for the same reason `fxPresetBrowser`'s is: it holds a cache of
 * eighty graded stills keyed by preset id, and remounting the panel should not
 * throw that away.
 */
const previews = createLutPreviewProvider();

/** Headings for the category enum. Absent falls back to the raw value. */
const CATEGORY_LABELS: Record<string, string> = {
  film: "Film",
  cinematic: "Cinematic",
  vintage: "Vintage",
  mono: "Black & White",
  warm: "Warm",
  cool: "Cool",
  vivid: "Vivid",
  matte: "Matte",
  "log-convert": "Log Conversion",
  utility: "Utility",
};

function toast(message: string): void {
  (document.querySelector("toast-box") as any)?.showToast({
    message,
    delay: "4000",
  });
}

@customElement("lut-browser")
export class LutBrowser extends LitElement {
  private query = "";
  private teardown: Array<() => void> = [];
  private visibility: IntersectionObserver | null = null;

  createRenderRoot() {
    this.teardown.push(
      selectionStore.subscribe(() => this.requestUpdate()),
      useTimelineStore.subscribe(() => this.requestUpdate()),
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
    if (presetsOfKind("lut").length === 0) {
      void loadPresets().then(() => this.requestUpdate());
    }

    /**
     * Repaint when the tab is opened.
     *
     * Without this the panel is permanently blank, and the reason is worth
     * stating because it is not obvious: the sidebar is a set of Bootstrap
     * pills, so this component mounts and renders at *app startup*, inside a
     * pane that is `display: none`. `updated()` fires then — with the tiles
     * hidden, so painting and building the still are both correctly skipped —
     * and Lit has no reason to run it again. Clicking the tab changes no
     * property of this element, so nothing else would ever ask.
     *
     * An `IntersectionObserver` rather than Bootstrap's `shown.bs.tab`: it
     * needs no reference to the tab machinery, and it covers the other case
     * that has the same shape — a tile scrolled into view for the first time.
     */
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
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
    this.visibility?.disconnect();
    this.visibility = null;
  }

  updated() {
    this.paintTiles();
  }

  private isHidden(): boolean {
    return this.closest(".d-none") != null || this.offsetParent == null;
  }

  /** Preset ids whose table is being read. See `paintTiles`. */
  private loading = new Set<string>();

  private paintTiles(): void {
    if (this.isHidden()) {
      return;
    }
    for (const node of this.querySelectorAll("canvas[data-lut]")) {
      const canvas = node as HTMLCanvasElement;
      const presetId = canvas.dataset.lut;
      if (presetId == null) {
        continue;
      }
      const ctx = canvas.getContext("2d");
      if (ctx == null) {
        continue;
      }
      const frame = previews.get(presetId);
      if (frame != null) {
        ctx.putImageData(frame, 0, 0);
        continue;
      }

      const lut = lutFor(presetId);
      if (lut != null) {
        // `request` grades the still and notifies, which repaints this tile.
        previews.request(presetId, lut);
        continue;
      }

      // Not read off disk yet. `lutFor` starts the read and answers `null`,
      // which is right for the paint loop and not enough here: eighty tiles
      // would each ask once, get nothing, and never be told the table had
      // arrived — the panel would sit blank until something else happened to
      // repaint it. So wait for it explicitly, once per preset.
      if (!this.loading.has(presetId)) {
        this.loading.add(presetId);
        void loadLut(presetId)
          .then((loaded) => {
            if (loaded != null) {
              previews.request(presetId, loaded);
            }
          })
          .finally(() => {
            this.loading.delete(presetId);
          });
      }
    }
  }

  // ------------------------------------------------------------- applying

  /** The clips in the selection that can actually take a grade. */
  private gradableSelection(): string[] {
    const document_ = useTimelineStore.getState();
    return selectionStore
      .getState()
      .ids.filter((id) => isGradable(document_.timeline[id]));
  }

  private apply(preset: FxPreset): void {
    const ids = this.gradableSelection();
    if (ids.length > 0) {
      // One call for N clips is one undo step. Declining by identity means
      // re-clicking the LUT a clip already has costs nothing.
      useTimelineStore
        .getState()
        .withCheckpoint((doc) => setClipLutMany(doc, ids, preset.id));
      return;
    }
    this.addAdjustmentLayer(preset);
  }

  /**
   * Grade everything beneath, rather than nothing at all.
   *
   * A tile that silently does nothing is the worst outcome. Falling back to an
   * adjustment layer matches what the Fx panel already does with no selection,
   * and it is the answer to "I want this look on the whole sequence" — which is
   * as common a request as "on this shot".
   */
  private addAdjustmentLayer(preset: FxPreset): void {
    const store = useTimelineStore.getState();
    const id = uuidv4();
    // The second id is for the effect *track* `addEffect` creates when there
    // is none. It insists on being given one rather than minting its own so
    // that the whole edit stays a pure function of the document.
    const trackId = uuidv4();
    store.withCheckpoint((doc) =>
      addEffect(
        doc,
        id,
        preset.id,
        store.cursor,
        DEFAULT_EFFECT_MS,
        trackId,
        {},
      ),
    );
    selectionStore.getState().setIds([id]);
    toast(`${preset.name} added as an adjustment layer.`);
  }

  private clear(): void {
    const ids = this.gradableSelection();
    if (ids.length === 0) {
      toast("Select a clip to clear its LUT.");
      return;
    }
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setClipLutMany(doc, ids, null));
  }

  private handleDragStart(event: DragEvent, preset: FxPreset): void {
    event.dataTransfer?.setData(LUT_PRESET_MIME, preset.id);
    if (event.dataTransfer != null) {
      event.dataTransfer.effectAllowed = "copy";
    }
  }

  // -------------------------------------------------------------- importing

  private async handleImport(): Promise<void> {
    const result = await pickAndImportLut();
    if (result == null) {
      return;
    }
    toast(
      result.ok
        ? `Imported ${result.name}.`
        : `That LUT could not be read — ${result.message}`,
    );
    this.requestUpdate();
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    const files = event.dataTransfer?.files;
    if (files == null || files.length === 0) {
      return;
    }
    event.preventDefault();
    for (const file of Array.from(files)) {
      const result = await importLutFile(file);
      toast(
        result.ok
          ? `Imported ${result.name}.`
          : `${file.name} could not be read — ${result.message}`,
      );
    }
    this.requestUpdate();
  }

  // ---------------------------------------------------------------- render

  private matchesQuery(preset: FxPreset): boolean {
    if (this.query === "") {
      return true;
    }
    return [
      preset.name,
      preset.category,
      CATEGORY_LABELS[preset.category] ?? "",
      preset.author ?? "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(this.query);
  }

  private tile(preset: FxPreset, current: string | null) {
    const active = current === preset.id;
    return html`
      <div
        class="col-6 d-flex flex-column bd-highlight overflow-hidden mt-1 asset"
        draggable="true"
        title=${preset.name}
        @click=${() => this.apply(preset)}
        @dragstart=${(e: DragEvent) => this.handleDragStart(e, preset)}
      >
        <canvas
          data-lut=${preset.id}
          width=${LUT_PREVIEW_W}
          height=${LUT_PREVIEW_H}
          style="width: 100%; aspect-ratio: 16/9; border-radius: 4px;
                 background: #2b2c33; display: block; pointer-events: none;
                 outline: ${active ? "2px solid #4b8dff" : "none"};
                 outline-offset: -2px;"
        ></canvas>
        <span
          class=${active ? "text-primary" : "text-light"}
          style="font-size: 11px; margin-top: 2px; white-space: nowrap;
                 overflow: hidden; text-overflow: ellipsis;"
        >
          ${preset.name}
        </span>
      </div>
    `;
  }

  render() {
    const all = presetsOfKind("lut");
    const matching = all.filter((preset) => this.matchesQuery(preset));
    const selection = this.gradableSelection();
    const document_ = useTimelineStore.getState().timeline;
    // Only when the whole selection agrees: a mixed selection has no one
    // current LUT, and highlighting the first clip's would be a lie.
    const currentIds = new Set(
      selection.map((id) => lutOf(document_[id])?.presetId ?? ""),
    );
    const current =
      selection.length > 0 && currentIds.size === 1
        ? [...currentIds][0] || null
        : null;

    const builtin = matching.filter((preset) => preset.origin === "builtin");
    const user = matching.filter((preset) => preset.origin === "user");

    const sections = LUT_CATEGORIES.map((category) => ({
      label: CATEGORY_LABELS[category] ?? category,
      presets: builtin.filter((preset) => preset.category === category),
    })).filter((section) => section.presets.length > 0);

    if (user.length > 0) {
      sections.unshift({ label: "My LUTs", presets: user });
    }

    const broken = lutFailures();

    return html`
      <div
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${(e: DragEvent) => void this.handleDrop(e)}
      >
        <div class="px-2 pt-1 d-flex gap-1">
          <input
            type="search"
            class="form-control form-control-sm bg-dark text-light border-secondary"
            style="font-size: 11px;"
            placeholder="Search LUTs"
            @input=${(e: Event) => {
              this.query = (e.target as HTMLInputElement).value
                .trim()
                .toLowerCase();
              this.requestUpdate();
            }}
          />
          <button
            class="btn btn-sm btn-outline-secondary text-nowrap flex-shrink-0"
            style="font-size: 11px;"
            title="Import a .cube, .3dl or LUT image"
            @click=${() => void this.handleImport()}
          >
            Import
          </button>
        </div>

        <div class="px-2 pt-1 d-flex gap-1">
          <button
            class="btn btn-sm btn-outline-secondary w-100"
            style="font-size: 11px;"
            @click=${() => this.clear()}
          >
            None — remove the LUT
          </button>
        </div>

        ${broken.length > 0
          ? html`<div class="text-warning px-2 pt-2" style="font-size: 10px;">
              ${broken.length} LUT${broken.length === 1 ? "" : "s"} could not be
              read: ${broken.map((f) => f.message).join("; ")}
            </div>`
          : null}
        ${all.length === 0
          ? html`<div class="text-secondary p-2" style="font-size: 11px;">
              No LUTs installed.
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
                    ${section.label}
                  </div>
                  <div class="row px-2">
                    ${section.presets.map((preset) =>
                      this.tile(preset, current),
                    )}
                  </div>
                `,
              )}
      </div>
    `;
  }
}
