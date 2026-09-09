import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type {
  TemplateElementType,
  TemplateFill,
} from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { probeMedia } from "../element/mediaProbe";
import { slotKindOf, type TemplateSlot } from "../template/slots";
import { templateFor, subscribeTemplates } from "../template/templateRegistry";
import {
  setTemplateFill,
  setTemplateFillOffset,
} from "../timeline/templateOps";
import "./controlDefaultTransform";

/**
 * The side panel for a template: its transform, and its slots.
 *
 * `<option-template>` needs no entry in `optionGroup.ts` — that dispatcher
 * resolves a panel by `option-${filetype}` and a template's filetype is
 * `"template"`. Only `<option-group>`'s own template in `Control.ts` has to
 * carry the tag.
 *
 * What it offers is deliberately short. **The transform and the slots, and
 * nothing else.** A template's length, its timing and its contents belong to
 * whoever authored it — `templateOps.ts#isDurationLocked` is the rule and this
 * panel is where a user meets it — so `default-transform` (position, size,
 * rotation, opacity, scale, and the parent pick-whip) plus one row per slot is
 * the whole surface.
 *
 * Two house rules are load-bearing here rather than stylistic. The panel reads
 * the store on **every render** and caches nothing, which is what makes it
 * follow undo and an agent's edits. And it sets `data-keeps-selection`, because
 * `elementTimelineCanvas._handleDocumentClick` clears the selection on any
 * mousedown that has not opted out — without it, clicking a slot's button would
 * act on nothing.
 */
@customElement("option-template")
export class OptionTemplate extends LitElement {
  elementId: string;

  @property()
  timelineState: any = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  isShow = false;

  /** Bumped when the registry changes, so a just-installed template appears. */
  @state()
  private libraryVersion = 0;

  private unsubscribeTemplates: (() => void) | null = null;

  createRenderRoot() {
    this.setAttribute("data-keeps-selection", "");

    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineCursor = state.cursor;
    });

    return this;
  }

  constructor() {
    super();
    this.elementId = "";
    this.hide();
  }

  connectedCallback() {
    super.connectedCallback();
    this.unsubscribeTemplates = subscribeTemplates(() => {
      this.libraryVersion += 1;
    });
  }

  disconnectedCallback() {
    this.unsubscribeTemplates?.();
    this.unsubscribeTemplates = null;
    super.disconnectedCallback();
  }

  /** The element, read fresh. Never cached — see the header. */
  private element(): TemplateElementType | null {
    const element = this.timeline?.[this.elementId];
    return element?.filetype === "template"
      ? (element as TemplateElementType)
      : null;
  }

  private slots(): TemplateSlot[] {
    const element = this.element();
    if (element == null) {
      return [];
    }
    return templateFor(element.templateId)?.slots ?? [];
  }

  private fillFor(slotId: string): TemplateFill | undefined {
    return this.element()?.fills?.[slotId];
  }

  private commit(fn: (doc: any) => any) {
    useTimelineStore.getState().withCheckpoint(fn);
  }

  // ------------------------------------------------------------------ slots

  /**
   * Pick a file for a media slot.
   *
   * Probed before it is stored, for the length: the in-point slider's range is
   * `0 … sourceDuration - slotDuration`, so a fill with no duration would give
   * a handle that cannot move. `probeMedia` is also the app's single gate on
   * what counts as media, so an unsupported file is refused here rather than
   * rendering as nothing later.
   */
  private async chooseMedia(slot: TemplateSlot) {
    const dialog = (window as any).electronAPI?.req?.dialog;
    const chosen = await dialog?.openFile([
      "mp4",
      "mov",
      "webm",
      "mkv",
      "avi",
      "png",
      "jpg",
      "jpeg",
      "webp",
      "gif",
    ]);
    if (chosen == null || chosen === "") {
      return;
    }

    let probe: any;
    try {
      probe = await probeMedia(chosen);
    } catch (error) {
      (document.querySelector("toast-box") as any)?.showToast({
        message: error instanceof Error ? error.message : "Unsupported file",
        delay: "3000",
      });
      return;
    }

    const fill: TemplateFill = {
      kind: "media",
      localpath: probe.localpath ?? chosen,
      offsetMs: 0,
      sourceDurationMs: Number(probe.duration) || 0,
    };
    this.commit((doc) =>
      setTemplateFill(doc, this.elementId, slot.slotId, fill),
    );
  }

  private clearSlot(slot: TemplateSlot) {
    this.commit((doc) => setTemplateFill(doc, this.elementId, slot.slotId, null));
  }

  private setText(slot: TemplateSlot, text: string) {
    this.commit((doc) =>
      setTemplateFill(doc, this.elementId, slot.slotId, {
        kind: "text",
        text,
      }),
    );
  }

  private setOffset(slot: TemplateSlot, offsetMs: number) {
    this.commit((doc) =>
      setTemplateFillOffset(doc, this.elementId, slot.slotId, offsetMs),
    );
  }

  private fileNameOf(localpath: string): string {
    return (localpath.split(/[\\/]/).pop() ?? localpath).replace(/%23/g, "#");
  }

  private mediaRow(slot: TemplateSlot) {
    const fill = this.fillFor(slot.slotId);
    const filled = fill?.kind === "media" ? fill : null;
    // The furthest in the source the slot can start and still be covered.
    const maxOffset = Math.max(
      0,
      (filled?.sourceDurationMs ?? 0) - slot.durationMs,
    );

    return html`
      <div class="d-flex align-items-center gap-2">
        <button
          class="btn btn-sm ${filled == null
            ? "btn-default"
            : "btn-primary"} text-light flex-fill text-start text-truncate"
          aria-event="template-slot-media"
          data-slot=${slot.slotId}
          @click=${() => this.chooseMedia(slot)}
        >
          <span class="material-symbols-outlined align-middle icon-sm"
            >${filled == null ? "add_photo_alternate" : "movie"}</span
          >
          <span class="align-middle ms-1"
            >${filled == null
              ? slot.label
              : this.fileNameOf(filled.localpath)}</span
          >
        </button>
        ${filled == null
          ? ""
          : html`<button
              class="btn btn-sm btn-default text-light"
              aria-event="template-slot-clear"
              data-slot=${slot.slotId}
              @click=${() => this.clearSlot(slot)}
            >
              <span class="material-symbols-outlined icon-sm">close</span>
            </button>`}
      </div>
      ${filled == null || maxOffset <= 0
        ? ""
        : html`<div class="d-flex align-items-center gap-2 mt-1">
            <span class="material-symbols-outlined icon-sm text-secondary"
              >content_cut</span
            >
            <input
              type="range"
              class="form-range"
              min="0"
              max=${maxOffset}
              step="1"
              aria-event="template-slot-offset"
              data-slot=${slot.slotId}
              .value=${String(filled.offsetMs)}
              @input=${(e: Event) =>
                this.setOffset(
                  slot,
                  Number((e.target as HTMLInputElement).value),
                )}
            />
          </div>`}
    `;
  }

  private textRow(slot: TemplateSlot) {
    const fill = this.fillFor(slot.slotId);
    const value = fill?.kind === "text" ? fill.text : slot.label;

    return html`
      <div class="d-flex align-items-center gap-2">
        <span class="material-symbols-outlined icon-sm text-secondary"
          >title</span
        >
        <input
          type="text"
          class="form-control form-control-sm bg-default text-light"
          aria-event="template-slot-text"
          data-slot=${slot.slotId}
          .value=${value}
          @input=${(e: Event) =>
            this.setText(slot, (e.target as HTMLInputElement).value)}
        />
      </div>
    `;
  }

  private slotList() {
    const element = this.element();
    if (element == null) {
      return "";
    }

    // A template that is not installed has no slot list — the contract
    // `templateFor` states. The name still shows, because it is on the element.
    if (templateFor(element.templateId) == null) {
      return html`<div class="d-flex align-items-center gap-2 px-2 text-warning">
        <span class="material-symbols-outlined icon-sm">error</span>
        <span class="text-truncate">${element.name}</span>
      </div>`;
    }

    const slots = this.slots();
    if (slots.length === 0) {
      return "";
    }

    return html`
      <div class="px-2 mt-2">
        <label class="form-label text-light">Slots</label>
        <div class="d-flex flex-column gap-2">
          ${slots.map(
            (slot) => html`
              <div>
                ${slot.kind === "text"
                  ? this.textRow(slot)
                  : this.mediaRow(slot)}
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  render() {
    // `libraryVersion` is read so Lit tracks it: a template installed while
    // this panel is open has to make the slots appear.
    void this.libraryVersion;

    return html`
      <default-transform
        .elementId=${this.elementId}
        .timeline=${this.timeline}
        .timelineCursor=${this.timelineCursor}
        .timelineState=${this.timelineState}
        .isShow=${this.isShow}
      ></default-transform>
      ${this.slotList()}
    `;
  }

  hide() {
    this.classList.add("d-none");
    this.isShow = false;
  }

  show() {
    this.classList.remove("d-none");
    this.isShow = true;
  }

  public setElementId({ elementId }) {
    this.elementId = elementId;
  }
}

/** Exported for the suite: which row shape a slot gets. */
export function rowKindFor(element: unknown): "media" | "text" | null {
  return slotKindOf(element as never);
}
