import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import { consume } from "@lit/context";
import { timelineContext } from "../../context/timelineContext";
import {
  RULER_OFFSET,
  TRACK_GAP,
  TRACK_HEIGHT,
} from "../timeline/layout";
import { clipsOnTrack } from "../timeline/tracks";
import { applyMenuPlacement } from "../menu/menuPlacement";

/**
 * The track header column.
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

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.tracks = state.tracks;
      this.requestUpdate();
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
      this.requestUpdate();
    });

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

  _handleClickResizePanel() {
    this.isAbleResize = true;
  }

  _handleMouseMove(e) {
    if (!this.isAbleResize) {
      return;
    }

    const elementControlComponent: any =
      document.querySelector("element-control");
    const resizeX = Math.max(20, e.clientX);

    this.uiState.updateTimelineVertical(resizeX);
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
            class="dropdown-item dropdown-item-sm"
            ?disabled=${track.index === 0}
            @click=${() => this.moveTrack(track.id, -1)}
          >
            Move up
          </button>
        </li>
        <li>
          <button
            class="dropdown-item dropdown-item-sm"
            ?disabled=${track.index === ordered.length - 1}
            @click=${() => this.moveTrack(track.id, 1)}
          >
            Move down
          </button>
        </li>
        <li><hr class="dropdown-divider" /></li>
        <li>
          <button
            class="dropdown-item dropdown-item-sm text-danger"
            @click=${() => this.removeTrack(track.id)}
          >
            ${deleteLabel}
          </button>
        </li>
      </ul>
    `;
  }

  render() {
    const ordered = [...this.tracks].sort((a, b) => a.index - b.index);
    const width = this.resize.timelineVertical.leftOption;

    const rows = ordered.map(
      (track) => html`
        <div
          class="track-header"
          style="height: ${TRACK_HEIGHT}px; margin-bottom: ${TRACK_GAP}px;"
        >
          <span class="track-name">${track.name}</span>
          <button
            class="btn btn-xxs btn-default text-light track-menu"
            title="Track options"
            aria-haspopup="menu"
            aria-expanded=${this.openMenu?.trackId === track.id}
            @click=${(e: MouseEvent) => this.toggleMenu(track.id, e)}
          >
            <span class="material-symbols-outlined icon-xs">more_vert</span>
          </button>
        </div>
      `,
    );

    const menu = this.renderMenu(ordered);

    return html`
      <style>
        .track-header {
          color: #ffffff;
          background-color: #1c1f23;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 0.5rem;
          box-sizing: border-box;
        }

        .track-name {
          color: #ececee;
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
        }

        .track-menu {
          flex: 0 0 auto;
        }

        ul.track-menu .dropdown-item {
          width: 100%;
          text-align: left;
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
      >
        <div
          style="position: relative; top: -${this.timelineOptions
            .canvasVerticalScroll}px;"
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
