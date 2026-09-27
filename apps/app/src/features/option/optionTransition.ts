/**
 * The inspector for a transition.
 *
 * Reached the way every other option panel is: `optionGroup` resolves
 * `option-${filetype}`, so this tag name is fixed by the element's `filetype`
 * rather than chosen.
 *
 * The control that earns its place is **alignment**. Where a clip has no
 * footage beyond the cut, that side of the transition holds a frozen frame —
 * and which side that is depends on the alignment. A clip trimmed to the last
 * frame of its source has no tail, so a centred transition there freezes on the
 * way out; an `end`-aligned one draws on the *incoming* clip's head instead,
 * which is usually real. The tooltips report how much real footage each choice
 * would get, so the trade is visible rather than guessed at.
 *
 * The panel says when frames are being held rather than hiding it. "0.8s of
 * this 1.2s dissolve is a held frame" is what tells the user whether to trim a
 * neighbour back, and it is invisible in the preview on a short transition.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { selectionStore } from "../../states/selectionStore";
import type {
  TransitionAlignment,
  TransitionElementType,
} from "../../@types/timeline";
import {
  removeTransition,
  setTransitionAlignment,
  setTransitionDuration,
  setTransitionParams,
  setTransitionPreset,
} from "../timeline/transitionOps";
import {
  freezeMs,
  maxTransitionMs,
  realFootageMs,
} from "../timeline/transitionGeometry";
import {
  defaultParamsFor,
  presetById,
  presetsOfKind,
} from "../fx/presetRegistry";
import { renderParamControls } from "../fx/fxParamControls";
import { GestureCommit } from "./gestureCommit";
import { beginInputScrub } from "../input/inputScrub";
import { section, sliderField } from "./optionKit";

const ALIGNMENTS: Array<{ value: TransitionAlignment; label: string }> = [
  { value: "start", label: "Start at cut" },
  { value: "center", label: "Centred" },
  { value: "end", label: "End at cut" },
];

@customElement("option-transition")
export class OptionTransition extends LitElement {
  elementId: string;

  constructor() {
    super();
    this.elementId = "";
    this.hide();
  }

  /** Coalesces a slider scrub into a single undo step. */
  private gesture = new GestureCommit();

  @property()
  timeline: any = useTimelineStore.getInitialState().timeline;

  @property()
  isShow = false;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.requestUpdate();
    });

    // Subscribed directly rather than waiting to be pushed at.
    // `optionGroup.showOption` is only called from the timeline canvas's
    // mousedown, so a selection made by the agent, the toolbar or a keyboard
    // shortcut never reaches the option column at all. The toolbar already
    // solved this the same way.
    selectionStore.subscribe((state) => {
      const id = state.ids[0];
      if (id != null && this.timeline[id]?.filetype === "transition") {
        this.elementId = id;
        this.requestUpdate();
      }
    });

    // Without this the canvas's document-level mousedown handler clears the
    // selection before any button in here gets its click.
    this.setAttribute("data-keeps-selection", "");

    return this;
  }

  hide() {
    this.classList.add("d-none");
    this.isShow = false;
  }

  show() {
    this.classList.remove("d-none");
    this.isShow = true;
  }

  setElementId({ elementId }: { elementId: string }) {
    this.elementId = elementId;
    this.requestUpdate();
  }

  /**
   * The element, read from the store on every render.
   *
   * Never cached in a field: the store's objects are shared with every undo
   * history entry, and a panel holding one would be editing all of them.
   */
  private get transition(): TransitionElementType | null {
    const element = useTimelineStore.getState().timeline[this.elementId];
    return element != null && element.filetype === "transition"
      ? element
      : null;
  }

  /** The longest this cut can support under the current alignment. */
  private maxMs(transition: TransitionElementType): number {
    const doc = useTimelineStore.getState().getDocument();
    const from = doc.elements[transition.fromId];
    const to = doc.elements[transition.toId];
    if (from == null || to == null) {
      return transition.duration;
    }
    return maxTransitionMs(from, to, transition.alignment);
  }

  /**
   * What each alignment could give, in real footage.
   *
   * Every alignment can *hold* a transition now — the clips' lengths are the
   * only hard limit. What differs is how much of it is real footage rather than
   * a held frame, and that is what makes one alignment worth choosing over
   * another on a cut with handles on only one side.
   */
  private optionsWithLimits(transition: TransitionElementType) {
    const doc = useTimelineStore.getState().getDocument();
    const from = doc.elements[transition.fromId];
    const to = doc.elements[transition.toId];

    return ALIGNMENTS.map((entry) => ({
      ...entry,
      real:
        from == null || to == null ? 0 : realFootageMs(from, to, entry.value),
    }));
  }

  /** How much of the current transition holds a frozen frame. */
  private frozenMs(transition: TransitionElementType): number {
    const doc = useTimelineStore.getState().getDocument();
    const from = doc.elements[transition.fromId];
    const to = doc.elements[transition.toId];
    if (from == null || to == null) {
      return 0;
    }
    return freezeMs(from, to, transition.alignment, transition.duration);
  }

  private commit(fn: (doc: any) => any) {
    useTimelineStore.getState().withCheckpoint(fn);
    this.requestUpdate();
  }

  private handleChangePreset = (e: Event) => {
    const presetId = (e.target as HTMLSelectElement).value;
    const id = this.elementId;
    // Parameters are re-seeded from the new preset's defaults rather than
    // carried across — see `transitionOps.setTransitionPreset`.
    this.commit((doc) =>
      setTransitionPreset(doc, id, presetId, defaultParamsFor(presetId)),
    );
  };

  private handleChangeAlignment = (alignment: TransitionAlignment) => {
    const id = this.elementId;
    this.commit((doc) => setTransitionAlignment(doc, id, alignment));
  };

  private handleChangeDuration = (ms: number) => {
    const id = this.elementId;
    this.commit((doc) => setTransitionDuration(doc, id, ms));
  };

  private handleScrubDuration = (ms: number) => {
    const id = this.elementId;
    this.gesture.apply((doc) => setTransitionDuration(doc, id, ms));
    this.requestUpdate();
  };

  private handleRemove = () => {
    const id = this.elementId;
    this.commit((doc) => removeTransition(doc, id));
    selectionStore.getState().clear();
  };

  render() {
    const transition = this.transition;
    if (transition == null) {
      return html``;
    }

    const preset = presetById(transition.presetId);
    const installed = presetsOfKind("transition");
    const max = this.maxMs(transition);
    const finiteMax = Number.isFinite(max) ? max : 10_000;
    const clamped =
      transition.requestedDuration != null &&
      transition.requestedDuration > transition.duration;
    const frozen = this.frozenMs(transition);

    return html`
      ${section({
        title: "Transition",
        grow: true,
        actions: html`
          <select
            class="opt-select"
            aria-label="transition preset"
            .value=${transition.presetId}
            @change=${this.handleChangePreset}
          >
            ${
              // A preset that is not installed still appears, selected, so the
              // dropdown does not silently show a different one as current.
              preset == null
                ? html`<option value=${transition.presetId}>
                    ${transition.presetId} (missing)
                  </option>`
                : ""
            }
            ${installed.map(
              (entry) =>
                html`<option value=${entry.id}>
                  ${entry.name}${entry.origin === "user" ? " *" : ""}
                </option>`,
            )}
          </select>
        `,
      })}
      ${section({
        title: "Settings",
        body: html`
          ${preset == null
            ? html`<div class="opt-hint" style="margin-bottom: 8px;">
                <span class="material-symbols-outlined opt-hint-icon"
                  >warning</span
                >
                Not installed. This cut renders as a plain cut, and its
                settings are kept.
              </div>`
            : ""}

          <div class="opt-field">
            <div class="opt-row">
              <label class="opt-label">Alignment</label>
            </div>
            <div
              class="opt-seg"
              role="group"
              aria-label="Alignment"
              style="margin-top: 6px;"
            >
              ${this.optionsWithLimits(transition).map(
                (entry) => html`
                  <button
                    type="button"
                    class="opt-seg-item ${transition.alignment === entry.value
                      ? "is-on"
                      : ""}"
                    aria-pressed=${transition.alignment === entry.value
                      ? "true"
                      : "false"}
                    title=${entry.real <= 0
                      ? "No footage beyond the cut this way, so frames would be held"
                      : Math.round(entry.real) + "ms of real footage this way"}
                    @click=${() => this.handleChangeAlignment(entry.value)}
                  >
                    ${entry.label}
                  </button>
                `,
              )}
            </div>
          </div>

          <div class="opt-field">
            ${sliderField({
              label: "Duration",
              suffix: "ms",
              value: transition.duration,
              min: 40,
              max: Math.round(finiteMax),
              step: 10,
              onScrub: this.handleScrubDuration,
              onCommit: this.handleChangeDuration,
              onTyped: this.handleChangeDuration,
              onInvalid: () => this.requestUpdate(),
            })}
          </div>

          <div
            class="opt-hint"
            style=${clamped || frozen > 0 ? "color: #d6a44a;" : ""}
          >
            <span class="material-symbols-outlined opt-hint-icon"
              >${clamped || frozen > 0 ? "warning" : "straighten"}</span
            >
            ${clamped
              ? "Shortened to " +
                Math.round(transition.duration) +
                "ms: the clips are only that long. " +
                Math.round(transition.requestedDuration ?? 0) +
                "ms is remembered, and returns if they get longer."
              : frozen > 0
                ? Math.round(frozen) +
                  "ms of this holds a frozen frame: the clips have no footage" +
                  " beyond the cut. Trim one back to blend real frames."
                : "Up to " + Math.round(finiteMax) + "ms at this cut."}
          </div>

          ${preset != null && preset.params.length > 0
            ? renderParamControls({
                params: preset.params,
                values: transition.params,
                onScrub: (key, value) => {
                  const id = this.elementId;
                  this.gesture.apply((doc) =>
                    setTransitionParams(doc, id, { [key]: value }),
                  );
                  this.requestUpdate();
                },
                onCommit: (key, value) => {
                  const id = this.elementId;
                  this.commit((doc) =>
                    setTransitionParams(doc, id, { [key]: value }),
                  );
                },
              })
            : ""}
        `,
      })}

      <button
        type="button"
        class="opt-text-btn"
        style="width: 100%; justify-content: center; height: 26px;
               color: #d97b7b; margin-top: 2px;"
        @click=${this.handleRemove}
      >
        Remove transition
      </button>
    `;
  }
}
