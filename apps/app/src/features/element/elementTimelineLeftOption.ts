import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import { consume } from "@lit/context";
import { timelineContext } from "../../context/timelineContext";
import {
  RULER_OFFSET,
  TRACK_GAP,
  TRACK_HEIGHT,
} from "../timeline/layout";
import { clipsOnTrack, type TrackKind } from "../timeline/tracks";

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

    return this;
  }

  private redrawTimeline() {
    const canvas: any = document.querySelector("element-timeline-canvas");
    canvas?.drawCanvas();
  }

  addTrack(kind: TrackKind) {
    this.timelineState.addTrack(kind, uuidv4());
    this.redrawTimeline();
  }

  removeTrack(trackId: string) {
    const doc = useTimelineStore.getState().getDocument();
    if (clipsOnTrack(doc, trackId).length > 0) {
      // Deleting a track with clips on it would silently delete footage; the
      // store refuses, and saying so beats appearing to do nothing.
      document
        .querySelector("toast-box")
        ?.showToast({ message: "Track is not empty", delay: "3000" });
      return;
    }

    this.timelineState.removeTrackById(trackId);
    this.redrawTimeline();
  }

  moveTrack(trackId: string, delta: number) {
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
          <div class="track-actions">
            <button
              class="btn btn-xxs btn-default text-light"
              title="Move up"
              ?disabled=${track.index === 0}
              @click=${() => this.moveTrack(track.id, -1)}
            >
              <span class="material-symbols-outlined icon-xs">
                keyboard_arrow_up
              </span>
            </button>
            <button
              class="btn btn-xxs btn-default text-light"
              title="Move down"
              ?disabled=${track.index === ordered.length - 1}
              @click=${() => this.moveTrack(track.id, 1)}
            >
              <span class="material-symbols-outlined icon-xs">
                keyboard_arrow_down
              </span>
            </button>
            <button
              class="btn btn-xxs btn-default text-light"
              title="Delete track"
              @click=${() => this.removeTrack(track.id)}
            >
              <span class="material-symbols-outlined icon-xs">delete</span>
            </button>
          </div>
        </div>
      `,
    );

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

        .track-actions {
          display: flex;
          gap: 2px;
        }

        .track-add {
          display: flex;
          gap: 4px;
          padding: 4px 0.5rem;
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
          <div class="track-add">
            <button
              class="btn btn-xxs btn-default text-light"
              @click=${() => this.addTrack("video")}
            >
              + V
            </button>
            <button
              class="btn btn-xxs btn-default text-light"
              @click=${() => this.addTrack("audio")}
            >
              + A
            </button>
            <button
              class="btn btn-xxs btn-default text-light"
              @click=${() => this.addTrack("text")}
            >
              + T
            </button>
          </div>
        </div>
      </div>
      <div
        class="split-col-bar"
        style="left: ${width}px;"
        @mousedown=${this._handleClickResizePanel}
      ></div>
    `;
  }
}
