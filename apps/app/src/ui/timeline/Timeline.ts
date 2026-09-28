import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import { IKeyframeStore, keyframeStore } from "../../states/keyframeStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { formatTimecode } from "../../features/timeline/timecode";
import "../../features/element/elementTimelineScroll";
import "../../features/element/elementTimelineBottom";
import "../../features/editor/timelineToolbar";
import { isTypingEvent } from "../../utils/typingTarget";

@customElement("timeline-ui")
export class Timeline extends LitElement {
  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  isAbleResize: boolean = false;

  @property()
  uiState: IUIStore = uiStore.getInitialState();

  @property()
  resize = this.uiState.resize;

  @property()
  keyframeState: IKeyframeStore = keyframeStore.getInitialState();

  @property()
  target = this.keyframeState.target;

  @property()
  fps: number = renderOptionStore.getInitialState().options.fps;

  @property()
  isPlay: boolean = this.timelineState.control.isPlay;

  @property()
  control = this.timelineState.control;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timelineCursor = state.cursor;
      this.isPlay = state.control.isPlay;
      this.control = state.control;
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
    });

    keyframeStore.subscribe((state) => {
      this.target = state.target;
    });

    renderOptionStore.subscribe((state) => {
      this.fps = state.options.fps;
    });

    window.addEventListener("mouseup", this._handleMouseUp.bind(this));
    window.addEventListener("mousemove", this._handleMouseMove.bind(this));
    document.addEventListener("keydown", this._handleKeydown.bind(this));

    return this;
  }

  play() {
    if (this.control.cursorType != "pointer") {
      return false;
    }
    const elementControlComponent = document.querySelector("element-control");
    elementControlComponent.play();

    this.timelineState.setPlay(true);
  }

  stop() {
    if (this.control.cursorType != "pointer") {
      return false;
    }

    const elementControlComponent = document.querySelector("element-control");
    elementControlComponent.stop();

    this.timelineState.setPlay(false);
  }

  _handleClickClosedKeyframe() {
    const keyframeEditor: HTMLElement | null =
      document.getElementById("option_bottom");
    if (keyframeEditor == null) return false;

    keyframeEditor.classList.remove("show");
    keyframeEditor.classList.add("hide");

    document
      .querySelector("element-timeline-canvas")
      .closeAnimationPanel(this.target.elementId);

    this.keyframeState.update({
      elementId: "",
      animationType: "position",
      isShow: false,
    });
  }

  _handleKeydown(event) {
    // Typing a space in a text field must not toggle playback.
    if (isTypingEvent(event)) {
      return;
    }

    // `event.code`, not the deprecated `keyCode`, to match the rest of the
    // app's shortcuts.
    if (event.code !== "Space") {
      return;
    }

    // Space is also a button's own activation key: the browser fires a click on
    // the *keyup* for whichever button still holds focus from the last mouse
    // click. So after using the ⟳ reset button, one press started playback here
    // and then re-ran the reset a moment later — the playhead snapped back to 0
    // and playback stopped. Cancelling the default suppresses that activation
    // (and the page scroll) and leaves this handler alone in charge of the key.
    event.preventDefault();

    // A held key repeats, and each repeat would flip play/stop again.
    if (event.repeat) {
      return;
    }

    if (this.isPlay) {
      this.stop();
    } else {
      this.play();
    }
  }

  _handleMouseMove(e) {
    if (!this.isAbleResize) {
      return;
    }

    const elementControlComponent = document.querySelector("element-control");
    const topBarHeight = 60;

    const windowHeight = window.innerHeight + topBarHeight;
    const nowY = e.clientY;
    const resizeY = 100 - (nowY / windowHeight) * 103; // 103인 이유는 Vertical 전체가 windowHeight의 97%이기 떄문.

    // Bounded by `VERTICAL_LIMITS` in the store, so dragging off either end of
    // the window pins the timeline rather than collapsing it or swallowing the
    // preview.
    this.uiState.updateVertical(resizeY);
    elementControlComponent.resizeEvent();
  }

  _handleMouseUp() {
    this.isAbleResize = false;
  }

  _handleClickResizeBar() {
    this.isAbleResize = true;
  }

  _handleClickPlay() {
    this.play();
  }

  _handleClickStop() {
    this.stop();
  }

  _handleClickReset() {
    const elementControlComponent = document.querySelector("element-control");
    elementControlComponent.reset();
    this.timelineState.setPlay(false);
  }

  togglePlayButton() {
    const label = this.isPlay ? "Stop" : "Play";
    return html`<button
      id="playToggle"
      class="transport-btn transport-btn-play"
      title="${label} (Space)"
      aria-label=${label}
      @click=${this.isPlay ? this._handleClickStop : this._handleClickPlay}
    >
      <span class="material-symbols-outlined"
        >${this.isPlay ? "stop" : "play_arrow"}</span
      >
    </button>`;
  }

  keyframeOption() {
    if (this.target.isShow) {
      return html`
        <button
          type="button"
          class="btn btn-dark btn-xs"
          data-bs-dismiss="offcanvas"
          @click=${this._handleClickClosedKeyframe}
          aria-label="close"
          style="    white-space: nowrap;"
        >
          Close Keyframe
        </button>
      `;
    }

    return html``;
  }

  render() {
    return html`
      <style>
        /* Play, reset and the timecode, as shadcn/ui icon buttons. Bare
           elements rather than .btn: the design system and style.scss set a
           .btn's padding !important, so a square could not centre its glyph.
           28px, because the ruler under this row sits at a hard-coded top of
           40px and the row must not grow. Greys are _option.scss's. */
        .transport {
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .transport-btn {
          appearance: none;
          flex: none;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          padding: 0;
          margin: 0;
          border: 1px solid transparent;
          border-radius: 6px;
          background-color: transparent;
          color: #7f878f;
          cursor: pointer;
          transition:
            background-color 150ms ease,
            color 150ms ease;
        }

        .transport-btn > .material-symbols-outlined {
          font-size: 20px;
          line-height: 1;
        }

        .transport-btn:hover {
          background-color: #1f2327;
          color: #c3c9cf;
        }

        .transport-btn:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px rgba(195, 201, 207, 0.35);
        }

        /* Play is the one a hand looks for, so it is the one with a fill. */
        .transport-btn-play {
          border-color: rgba(255, 255, 255, 0.07);
          background-color: #1c1f23;
          color: #c3c9cf;
        }

        .transport-btn-play:hover {
          background-color: #2a3036;
          color: #f1f3f5;
        }

        /* A readout: monospaced with tabular figures, so the digits do not
           shift sideways as they count during playback. */
        .transport-timecode {
          margin-left: 4px;
          padding: 3px 8px;
          border-radius: 6px;
          color: #c3c9cf;
          font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          line-height: 20px;
          white-space: nowrap;
        }
      </style>

      <div
        class="split-bottom-bar cursor-row-resize "
        @mousedown=${this._handleClickResizeBar}
      ></div>

      <div class="row mb-2">
        <div class="col-4">
          <div class="transport">
            ${this.togglePlayButton()}
            <button
              class="transport-btn"
              title="Go to start"
              aria-label="Go to start"
              @click=${this._handleClickReset}
            >
              <span class="material-symbols-outlined">replay</span>
            </button>
            <span class="transport-timecode"
              >${formatTimecode(this.timelineCursor, this.fps)}</span
            >
          </div>
        </div>
        <div class="d-flex col col-5 gap-2">
          <timeline-toolbar class="w-100"></timeline-toolbar>
          <div
            class="d-flex justify-content-end"
            id="keyframeEditorButtonGroup"
          >
            ${this.keyframeOption()}
          </div>
        </div>

        <div class="col-3 row d-flex align-items-center m-0 p-0">
          <element-timeline-range></element-timeline-range>
        </div>
      </div>

      <element-timeline-ruler></element-timeline-ruler>
      <element-timeline id="split_inner_bottom"></element-timeline>
      <element-timeline-bottom-scroll></element-timeline-bottom-scroll>
      <element-timeline-bottom></element-timeline-bottom>
    `;
  }
}
