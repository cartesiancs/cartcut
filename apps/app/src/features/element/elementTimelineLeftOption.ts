import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import { timelineLockStore } from "../../states/timelineLockStore";
import { timelineIsLocked } from "../editor/timelineLock";
import {
  effectiveTrackHeights,
  trackHeightStore,
} from "../../states/trackHeightStore";
import { coerceTrackHeight, trackHeightOf } from "../timeline/trackHeights";
import { createTrackResizeController } from "../timeline/trackResize";
import { consume } from "@lit/context";
import { timelineContext } from "../../context/timelineContext";
import { RULER_OFFSET, TRACK_GAP, TRACK_HEIGHT } from "../timeline/layout";
import { defaultColors } from "../timeline/draw";
import {
  clipsOnTrack,
  isTrackHidden,
  type TrackKind,
} from "../timeline/tracks";
import {
  TRACK_KIND_CAN_HIDE,
  TRACK_KIND_ICON,
  TRACK_KIND_TITLE,
} from "../timeline/trackKinds";
import { setTrackHidden } from "../editor/actions";
import { addEffectTrack as addEffectTrackOp } from "../timeline/effectOps";
import { applyMenuPlacement } from "../menu/menuPlacement";
import { v4 as uuidv4 } from "uuid";

/**
 * The track header column.
 *
 * A row shows its kind's icon rather than its name. It used to print
 * `track.name` — "V1", "A1" — which spent the header's whole width restating
 * something the row's own contents already say, and numbered rows the user
 * cannot address by number anywhere in the UI. The kind is the only part that
 * carried information, so it is drawn as its icon and the ordinal is dropped.
 * `track.name` is untouched: the agent and the MCP tools still name tracks by
 * it. The icon and the tooltip come from `timeline/trackKinds`, which the
 * toolbar's "Add track" menu also reads — a kind is named once, in one place.
 *
 * This used to list *elements* — one row per clip, with an animation-panel
 * toggle each — and it computed its own row positions with a private copy of
 * `index * 30 * 1.2`, matching (or not matching) the three other copies
 * elsewhere. Now it lists tracks, and its geometry comes from the same
 * `TRACK_HEIGHT`/`TRACK_GAP` the canvas lays out with, so the two columns
 * cannot drift apart.
 *
 * Keyframe editing moved to the bottom editor: with many clips per row there is
 * no longer a row belonging to one element to expand.
 *
 * A row is resized from here, by the strip along the bottom edge of its header
 * (`timeline/trackResize.ts` holds the rules, this class the DOM). The canvas
 * draws from the same `trackHeightStore`, so header and row change height in
 * the same frame.
 */
@customElement("element-timeline-left-option")
export class ElementTimelineLeftOption extends LitElement {
  @property({ attribute: false })
  uiState: IUIStore = uiStore.getInitialState();

  @property({ attribute: false })
  resize = this.uiState.resize;

  @property({ attribute: false })
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property({ attribute: false })
  timeline: any = this.timelineState.timeline;

  @property({ attribute: false })
  tracks = this.timelineState.tracks;

  @property({ attribute: false })
  isAbleResize: boolean = false;

  /**
   * The track whose ⋯ menu is open, and where to draw it.
   *
   * The column clips its overflow, so the menu is positioned `fixed` against
   * coordinates captured from the button at click time rather than nested in
   * the row — a row is only 40px tall and would cut the menu off.
   */
  @property({ attribute: false })
  openMenu: { trackId: string; x: number; y: number } | null = null;

  @consume({ context: timelineContext })
  @property({ attribute: false })
  public timelineOptions: any = {
    canvasVerticalScroll: 0,
  };

  /** The row whose edge is being dragged, for the edge's dragging style. */
  private resizingTrackId: string | null = null;

  /** The scroll the resize gesture last heard about. */
  private lastScroll = 0;

  private readonly rowResize = createTrackResizeController(
    {
      preview: (trackId, px) =>
        trackHeightStore.getState().preview(trackId, px),
      commit: () => trackHeightStore.getState().commit(),
      cancel: () => trackHeightStore.getState().cancel(),
      reset: (trackId) => trackHeightStore.getState().reset(trackId),
      setActive: (trackId, on) => {
        // The cursor for the whole window, not just the edge: the pointer
        // leaves the 8px strip on the first pixel of a drag, and the canvas
        // sets its own cursor on everything it hovers.
        document.body.classList.toggle("is-resizing-track", on);
        this.resizingTrackId = on ? trackId : null;
        this.requestUpdate();
      },
      listen: (on) => this.listenForRowResize(on),
    },
    coerceTrackHeight,
  );

  private onRowResizeMove = (e: PointerEvent) => {
    this.rowResize.dispatch({
      type: "move",
      pointerId: e.pointerId,
      clientY: e.clientY,
      buttons: e.buttons,
    });
  };

  private onRowResizeUp = (e: PointerEvent) => {
    this.rowResize.dispatch({ type: "up", pointerId: e.pointerId });
  };

  private onRowResizeCancel = (e: PointerEvent) => {
    this.rowResize.dispatch({ type: "pointercancel", pointerId: e.pointerId });
  };

  private onRowResizeBlur = () => {
    this.rowResize.dispatch({ type: "blur" });
  };

  /**
   * Escape reverts a resize, and only then is it swallowed: in the capture
   * phase on the window, ahead of the canvas's own Escape, which would also
   * clear the clip selection.
   */
  private onRowResizeKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") {
      return;
    }
    if (this.rowResize.dispatch({ type: "escape" })) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  /**
   * On the window rather than the edge, so the end of the gesture is heard
   * wherever it happens. Pointer capture routes the moves to the edge and they
   * bubble here; `lostpointercapture` is deliberately not one of the ways a
   * gesture ends, because `repeat` moving a row in the DOM drops the capture
   * while the drag goes on.
   */
  private listenForRowResize(on: boolean) {
    if (on) {
      window.addEventListener("pointermove", this.onRowResizeMove);
      window.addEventListener("pointerup", this.onRowResizeUp);
      window.addEventListener("pointercancel", this.onRowResizeCancel);
      window.addEventListener("blur", this.onRowResizeBlur);
      window.addEventListener("keydown", this.onRowResizeKeydown, true);
      return;
    }
    window.removeEventListener("pointermove", this.onRowResizeMove);
    window.removeEventListener("pointerup", this.onRowResizeUp);
    window.removeEventListener("pointercancel", this.onRowResizeCancel);
    window.removeEventListener("blur", this.onRowResizeBlur);
    window.removeEventListener("keydown", this.onRowResizeKeydown, true);
  }

  private onGripPointerDown(trackId: string, e: PointerEvent) {
    const accepted = this.rowResize.dispatch({
      type: "down",
      trackId,
      pointerId: e.pointerId,
      clientY: e.clientY,
      scroll: this.verticalScroll(),
      startPx: trackHeightOf(trackHeightStore.getState().heights, trackId),
      button: e.button,
      isPrimary: e.isPrimary,
      ctrlKey: e.ctrlKey,
    });
    if (!accepted) {
      return;
    }
    // No `preventDefault` here: on a `pointerdown` it would also suppress the
    // `mousedown` that closes the ⋯ menu, the toolbar's popovers and the export
    // popover. Text selection is stopped on the `mousedown` instead.
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the window
      // listeners still end the gesture.
    }
  }

  private verticalScroll(): number {
    return this.timelineOptions?.canvasVerticalScroll ?? 0;
  }

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      if (state.tracks !== this.tracks) {
        this.rowResize.dispatch({
          type: "tracks",
          ids: state.tracks.map((track) => track.id),
        });
      }
      this.timeline = state.timeline;
      this.tracks = state.tracks;
      this.requestUpdate();
    });

    // A resize in progress and every committed height. Read in `render`
    // through `effectiveTrackHeights`, which is memoised, so this only has to
    // say that something changed.
    trackHeightStore.subscribe(() => this.requestUpdate());

    // `resize` is the only field of this store the component renders, and it
    // keeps its reference across writes that do not touch it. The update was
    // unconditional, so every `topBarTitle` or `isOptionPanelActive` write
    // scheduled a re-render that produced identical markup.
    uiStore.subscribe((state) => {
      if (state.resize === this.resize) {
        return;
      }
      this.resize = state.resize;
      this.requestUpdate();
    });

    // Twice per caption session, so the lock glyph appears and goes with it.
    // The store guards its own writes, so this fires only on a real change.
    timelineLockStore.subscribe(() => this.requestUpdate());

    window.addEventListener("mouseup", this._handleMouseUp.bind(this));
    window.addEventListener("mousemove", this._handleMouseMove.bind(this));
    window.addEventListener("mousedown", this._handleDocumentMouseDown);
    window.addEventListener("keydown", this._handleMenuKeydown);

    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("mousedown", this._handleDocumentMouseDown);
    window.removeEventListener("keydown", this._handleMenuKeydown);

    // A resize cannot outlive the column that draws it: drop what it drew,
    // take the window listeners and the body's cursor with it.
    const gesture = this.rowResize.state();
    if (gesture.phase !== "idle") {
      this.rowResize.dispatch({
        type: "pointercancel",
        pointerId: gesture.pointerId,
      });
    }
  }

  /**
   * Tell a resize in progress that the rows scrolled under it.
   *
   * The canvas owns the scroll and asks this column to update whenever it
   * moves (`syncTrackHeaders`), so this is where the change is seen. In
   * `willUpdate`, before `render`, so a preview it causes is drawn by this
   * same update rather than scheduling another.
   */
  protected willUpdate(changed: PropertyValues) {
    super.willUpdate(changed);
    const v = this.verticalScroll();
    if (v !== this.lastScroll) {
      this.lastScroll = v;
      this.rowResize.dispatch({ type: "scroll", v });
    }
  }

  /** Any press that is not on the menu itself dismisses it. */
  private _handleDocumentMouseDown = (e: MouseEvent) => {
    if (this.openMenu == null) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest(".track-menu") != null) {
      return;
    }
    this.closeMenu();
  };

  private _handleMenuKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      this.closeMenu();
    }
  };

  private closeMenu() {
    if (this.openMenu != null) {
      this.openMenu = null;
      this.requestUpdate();
    }
  }

  private toggleMenu(trackId: string, e: MouseEvent) {
    // The window-level dismisser sees this press too; without stopping it the
    // menu would close in the same gesture that opened it.
    e.stopPropagation();

    if (this.openMenu?.trackId === trackId) {
      this.closeMenu();
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.openMenu = { trackId, x: rect.right, y: rect.bottom + 2 };
    this.requestUpdate();
  }

  private redrawTimeline() {
    const canvas: any = document.querySelector("element-timeline-canvas");
    canvas?.drawCanvas();
  }

  /**
   * Delete a track and whatever is on it.
   *
   * This used to refuse whenever the track held clips, leaving only a toast —
   * so on any track a user actually had something on, the button looked
   * broken. Behind a menu the choice is deliberate, the label says how many
   * clips go with it, and the whole thing is one checkpoint, so undo brings
   * the track and its clips back together.
   */
  removeTrack(trackId: string) {
    this.closeMenu();
    this.timelineState.removeTrackById(trackId, "delete-clips");
    this.redrawTimeline();
  }

  /**
   * Flip a row's eye. The window-level menu dismisser sees this press too,
   * which is wanted: a menu open on another row closes, as any click does.
   */
  private toggleHidden(trackId: string, hidden: boolean) {
    setTrackHidden(trackId, hidden);
    this.redrawTimeline();
  }

  private clipCountOn(trackId: string): number {
    return clipsOnTrack(useTimelineStore.getState().getDocument(), trackId)
      .length;
  }

  moveTrack(trackId: string, delta: number) {
    this.closeMenu();
    const track = this.tracks.find((candidate) => candidate.id === trackId);
    if (!track) {
      return;
    }
    this.timelineState.moveTrackTo(trackId, track.index + delta);
    this.redrawTimeline();
  }

  /**
   * A wheel over the headers scrolls the timeline, the same as one over the
   * canvas.
   *
   * The two columns are one scrollable surface — the canvas paints its own
   * vertical offset and this column is pushed by the same number — so the
   * gesture has to work on both halves or the header a user is pointing at is
   * the one place it does not. The scroll value is the canvas's, and the event
   * is forwarded whole rather than worked out again here: vertical, horizontal
   * and the Ctrl/pinch zoom all go through the one implementation, so nothing
   * about the two halves can drift.
   */
  private _handleWheel(e: WheelEvent) {
    const canvas: any = document.querySelector("element-timeline-canvas");
    canvas?.applyWheel(e);
  }

  _handleClickResizePanel() {
    this.isAbleResize = true;
  }

  _handleMouseMove(e) {
    if (!this.isAbleResize) {
      return;
    }

    const elementControlComponent: any =
      document.querySelector("element-control");

    // The window width goes along so the store can keep the canvas from being
    // pushed off the right edge on a narrow window; the fixed px bounds live in
    // `TIMELINE_LEFT_OPTION_LIMITS`.
    this.uiState.updateTimelineVertical(e.clientX, window.innerWidth);
    elementControlComponent?.resizeEvent();
    this.redrawTimeline();
  }

  _handleMouseUp() {
    this.isAbleResize = false;
  }

  /**
   * Place the open menu once Lit has rendered it.
   *
   * Runs on every update because the template re-emits the placeholder `top`
   * and `left` each time, so the measured values have to be written back after
   * each render. Cheap: one forced layout on a three-item list, and only while
   * a menu is open.
   */
  protected updated() {
    const open = this.openMenu;
    if (open == null) {
      return;
    }
    // `ul.` matters: every row's `⋯` button also carries `.track-menu`, so the
    // dismisser's `closest()` check covers both. A bare `.track-menu` here
    // finds the first button instead — the rows are rendered before the menu —
    // and would leave the real menu hidden for good.
    const menu = this.querySelector("ul.track-menu") as HTMLElement | null;
    if (menu == null) {
      return;
    }
    applyMenuPlacement(menu, { x: open.x, y: open.y }, { alignRight: true });
    menu.style.visibility = "visible";
  }

  /**
   * The open track's ⋯ menu, drawn once at the top level.
   *
   * Kept out of the row so the column's `overflow: hidden` cannot clip it, and
   * so only one menu exists at a time regardless of how many tracks there are.
   */
  private renderMenu(ordered: typeof this.tracks) {
    const open = this.openMenu;
    if (open == null) {
      return null;
    }

    const track = ordered.find((candidate) => candidate.id === open.trackId);
    if (track == null) {
      return null;
    }

    const clips = this.clipCountOn(track.id);
    const deleteLabel =
      clips === 0
        ? "Delete track"
        : `Delete track and ${clips} clip${clips === 1 ? "" : "s"}`;

    // Positioned imperatively in `updated()`, not here: `left` and `top` depend
    // on the menu's measured size, which does not exist until this template has
    // rendered. The `translateX(-100%)` that used to right-align it is gone —
    // `placeMenu`'s `alignRight` does the same thing, and doing it through the
    // real `left` is what lets the horizontal clamp see where the menu's left
    // edge actually is.
    return html`
      <ul
        class="dropdown-menu show track-menu"
        style="position: fixed; top: 0px; left: 0px; z-index: 6000;
               visibility: hidden;"
      >
        <li>
          <button
            class="dropdown-item dropdown-item-sm dropdown-item-icon"
            ?disabled=${track.index === 0}
            @click=${() => this.moveTrack(track.id, -1)}
          >
            <span class="material-symbols-outlined icon-xs">arrow_upward</span>
            Move up
          </button>
        </li>
        <li>
          <button
            class="dropdown-item dropdown-item-sm dropdown-item-icon"
            ?disabled=${track.index === ordered.length - 1}
            @click=${() => this.moveTrack(track.id, 1)}
          >
            <span class="material-symbols-outlined icon-xs"
              >arrow_downward</span
            >
            Move down
          </button>
        </li>
        <li><hr class="dropdown-divider" /></li>
        <li>
          <button
            class="dropdown-item dropdown-item-sm dropdown-item-icon"
            @click=${() => this.addEffectTrack()}
          >
            <span class="material-symbols-outlined icon-xs">add</span>
            Add effect track
          </button>
        </li>
        <li><hr class="dropdown-divider" /></li>
        <li>
          <button
            class="dropdown-item dropdown-item-sm dropdown-item-icon text-danger"
            @click=${() => this.removeTrack(track.id)}
          >
            <span class="material-symbols-outlined icon-xs">delete</span>
            ${deleteLabel}
          </button>
        </li>
      </ul>
    `;
  }

  /**
   * Add a row for full-frame effects, at the top of the stack.
   *
   * The only way to make one from the UI — until now nothing in the app added a
   * track at all, and `addTrack` was reachable only from the agent.
   *
   * Index 0 is deliberate and is not merely "the top". An effect applies to
   * everything painted beneath it, so a row at the bottom of the stack would
   * apply to nothing; `addEffectTrack` puts it in front and the user narrows
   * the scope afterwards by dragging it down.
   */
  private addEffectTrack() {
    this.openMenu = null;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => addEffectTrackOp(doc, uuidv4()));
  }

  /**
   * The row's eye, beside the menu.
   *
   * Boxed (`is-on`) while the row is hidden and plain while it shows, which is
   * the reverse of `optionKit.eyeButton`: there the eye opens a section, here
   * switching it on is what hides something, and nearly every row is shown,
   * so only the exception stands out.
   *
   * While the timeline is locked the button goes the way the menu does, since
   * it could only decline. A hidden row still says so, as a glyph, or the
   * state would vanish from the header for as long as the caption panel is
   * open while the preview goes on leaving the row out.
   */
  private renderEye(
    trackId: string,
    kind: TrackKind,
    hidden: boolean,
    locked: boolean,
  ) {
    if (!TRACK_KIND_CAN_HIDE[kind]) {
      return null;
    }
    if (locked) {
      return hidden
        ? html`<span
            class="material-symbols-outlined track-lock"
            title="Hidden. Locked while the caption panel is open"
            >visibility_off</span
          >`
        : null;
    }
    const title = hidden ? "Show track" : "Hide track";
    return html`<button
      type="button"
      class="opt-icon-btn track-eye ${hidden ? "is-on" : ""}"
      title=${title}
      aria-label=${title}
      aria-pressed=${hidden ? "true" : "false"}
      @click=${() => this.toggleHidden(trackId, !hidden)}
    >
      <span class="material-symbols-outlined"
        >${hidden ? "visibility_off" : "visibility"}</span
      >
    </button>`;
  }

  render() {
    const ordered = [...this.tracks].sort((a, b) => a.index - b.index);
    const width = this.resize.timelineVertical.leftOption;
    // Asked without announcing, because this is a render path: `refusesEdit`
    // raises a toast on its first refusal, and a window resize is not a refusal.
    const locked = timelineIsLocked();
    const heights = effectiveTrackHeights();

    // Keyed by track id, so a row's element (and the edge holding the pointer
    // capture of a resize in progress) stays with its track when rows are
    // added, removed or reordered, rather than being handed to whichever track
    // now sits at that position.
    const rows = repeat(ordered, (track) => track.id, (track) => {
      const hidden = isTrackHidden(track);
      const height = trackHeightOf(heights, track.id);
      return html`
        <div
          class="track-header ${hidden ? "is-hidden" : ""}"
          style="height: ${height}px; margin-bottom: ${TRACK_GAP}px;
                 background-color: ${defaultColors.row};"
        >
          <!-- The controls keep a default row's band, so a tall row has them
               at its top beside the clip's label rather than floating in the
               middle, and a default row lays out exactly as it always has. -->
          <div
            class="track-header-band"
            style="height: ${Math.min(height, TRACK_HEIGHT)}px;"
          >
            <span
              class="material-symbols-outlined track-icon"
              title=${TRACK_KIND_TITLE[track.kind] ?? "Track"}
              >${TRACK_KIND_ICON[track.kind] ?? "layers"}</span
            >
            <div class="track-actions">
              ${this.renderEye(track.id, track.kind, hidden, locked)}
              ${locked
                ? html`<span
                    class="material-symbols-outlined track-lock"
                    title="Locked while the caption panel is open"
                    >lock</span
                  >`
                : html`<button
                    type="button"
                    class="opt-icon-btn track-menu ${this.openMenu?.trackId ===
                    track.id
                      ? "is-on"
                      : ""}"
                    title="Track options"
                    aria-haspopup="menu"
                    aria-expanded=${this.openMenu?.trackId === track.id}
                    @click=${(e: MouseEvent) => this.toggleMenu(track.id, e)}
                  >
                    <span class="material-symbols-outlined">more_vert</span>
                  </button>`}
            </div>
          </div>
          <!-- Offered while the timeline is locked too: a row's height is
               view state, and the caption session never rewrites it. -->
          <div
            class="track-resize-grip ${this.resizingTrackId === track.id
              ? "is-dragging"
              : ""}"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize track"
            data-keeps-selection
            @pointerdown=${(e: PointerEvent) =>
              this.onGripPointerDown(track.id, e)}
            @mousedown=${(e: MouseEvent) => e.preventDefault()}
            @dblclick=${() =>
              this.rowResize.dispatch({ type: "dblclick", trackId: track.id })}
          ></div>
        </div>
      `;
    });

    const menu = this.renderMenu(ordered);

    return html`
      <style>
        /*
         * Filled, on the element, with the grey the canvas paints the row
         * beside it, so a header and its row read as one lane. Only the outer
         * corners are rounded; the inner edge runs on into the canvas.
         */
        .track-header {
          position: relative;
          margin-left: 6px;
          padding: 0 6px 0 8px;
          border-radius: 8px 0 0 8px;
          color: #c3c9cf;
          box-sizing: border-box;
        }

        .track-header-band {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        /*
         * The bottom edge, as a window edge: 8px to grab, centred on the gap
         * below the row and never painted itself, so the cursor is the
         * affordance. The line in the gap appears once the pointer has rested
         * on it a moment (a pass across the column on the way somewhere else
         * draws nothing) and stays for as long as a drag holds it.
         * Above the next row's header, which is later in the DOM and would
         * otherwise take the 2px of the strip that overlap it.
         */
        .track-resize-grip {
          position: absolute;
          left: 0;
          right: 0;
          bottom: -6px;
          height: 8px;
          z-index: 1;
          cursor: row-resize;
        }

        .track-resize-grip::after {
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          top: 3px;
          height: 2px;
          border-radius: 1px;
          background-color: #c3c9cf;
          opacity: 0;
          transition: opacity 120ms ease;
          pointer-events: none;
        }

        .track-resize-grip:hover::after {
          opacity: 0.45;
          transition-delay: 150ms;
        }

        .track-resize-grip.is-dragging::after {
          opacity: 0.9;
          transition-delay: 0s;
        }

        /*
         * The kind, in a small well: the option panel's hairline and text grey,
         * and the glyph's outline rather than the app-wide solid fill, which at
         * this size is a blot. Every axis is restated because
         * font-variation-settings replaces the whole list.
         */
        .track-icon {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 6px;
          background-color: rgba(255, 255, 255, 0.04);
          font-size: 15px;
          line-height: 1;
          font-variation-settings: "FILL" 0, "wght" 400, "GRAD" 0, "opsz" 20;
        }

        /* The eye and the menu, pushed to the end together. .opt-icon-btn
           draws each button; the menu stays last, so the eyes line up in one
           column whether or not a row has one. */
        .track-actions {
          display: flex;
          align-items: center;
          gap: 2px;
          margin-left: auto;
        }

        .track-header:hover .track-actions > .opt-icon-btn:not(.is-on) {
          color: #c3c9cf;
        }

        /* Matches the canvas, which draws this row's clips at 0.4. */
        .track-header.is-hidden > .track-icon {
          opacity: 0.45;
        }

        /*
         * Said, not merely enforced. Every item behind the track menu would
         * decline while the timeline is locked, so the menu is replaced rather
         * than disabled: an affordance that could only decline is not offered,
         * and a row with nothing in its place would read as a row that had lost
         * its controls for no reason. Boxed like the button it stands in for,
         * so nothing in the row moves when it swaps.
         */
        .track-lock {
          flex: none;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          color: #7f878f;
          font-size: 15px;
          line-height: 1;
          font-variation-settings: "FILL" 0, "wght" 400, "GRAD" 0, "opsz" 20;
          cursor: default;
        }

        /* Layout and icon colour come from .dropdown-item-icon in
           _dropdown.scss, shared with the timeline's right-click menu. What is
           left here is only what makes a button look like the anchor that
           Bootstrap styles. */
        ul.track-menu .dropdown-item {
          width: 100%;
          background: none;
          border: 0;
        }

        ul.track-menu .dropdown-item:disabled {
          opacity: 0.4;
          pointer-events: none;
        }
      </style>
      <div
        style="width: ${width}px;position: absolute; height: 100%; overflow: hidden;"
        class="tab-content"
        @wheel=${this._handleWheel}
      >
        <div
          style="position: relative; top: -${
            this.timelineOptions.canvasVerticalScroll
          }px;"
        >
          <!-- Matches the canvas's own reserved strip so the headers line up
               with the rows they name. -->
          <div style="height: ${RULER_OFFSET}px;"></div>
          ${rows}
        </div>
      </div>
      <div
        class="split-col-bar"
        style="left: ${width}px;"
        @mousedown=${this._handleClickResizePanel}
      ></div>
      ${menu}
    `;
  }
}
