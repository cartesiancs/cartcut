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
import { addEffect, setEffectPreset } from "../timeline/effectOps";
import {
  addTransition,
  cutPointsOn,
  setTransitionPreset,
} from "../timeline/transitionOps";
import { DEFAULT_TRANSITION_MS } from "../timeline/transitionGeometry";
import { DEFAULT_EFFECT_MS } from "../element/effectElement";
import { FX_PRESET_MIME } from "../asset/dropIntent";

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

  createRenderRoot() {
    // The grid reflects what is selected — a transition tile applies to the
    // selected transition if there is one — so it has to repaint on selection
    // and on document changes.
    selectionStore.subscribe(() => this.requestUpdate());
    useTimelineStore.subscribe(() => this.requestUpdate());

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
      >
        <!--
          A preset that ships no thumbnail gets a neutral grey plate. Grey
          rather than a colour on purpose: it is a placeholder, and a tinted one
          reads as artwork the preset chose, so the presets that do ship a real
          thumbnail stop standing out from the ones that do not.
        -->
        ${preset.thumbnailPath != null
          ? html`<img
              src=${"file://" + preset.thumbnailPath}
              style="width: 100%; aspect-ratio: 16/9; object-fit: cover;
                     border-radius: 4px;"
            />`
          : html`<div
              style="width: 100%; aspect-ratio: 16/9; border-radius: 4px;
                     background: #2b2c33;
                     display: flex; align-items: center; justify-content: center;"
            >
              <span class="material-symbols-outlined text-light icon-sm">
                ${this.kind === "effect" ? "auto_awesome" : "swap_horiz"}
              </span>
            </div>`}
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

  render() {
    const presets = presetsOfKind(this.kind);

    return html`
      <div class="row px-2">
        ${presets.length === 0
          ? html`<div class="text-secondary p-2" style="font-size: 11px;">
              No ${this.kind} presets installed.
            </div>`
          : presets.map((preset) => this.tile(preset))}
      </div>

    `;
  }
}
