import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import { IKeyframeStore, keyframeStore } from "../../states/keyframeStore";
import "../../features/element/elementTimelineScroll";
import "../../features/element/elementTimelineBottom";
import "../../features/gpt/aiInput";
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

    if (event.keyCode == 32) {
      //event.preventDefault();
      // Space
      if (this.isPlay) {
        this.stop();
      } else {
        this.play();
      }
    }
  }

  _handleMouseMove(e) {
    const elementControlComponent = document.querySelector("element-control");

    if (this.isAbleResize) {
      const topBarHeight = 60;

      const windowHeight = window.innerHeight + topBarHeight;
      const nowY = e.clientY;
      const resizeY = 100 - (nowY / windowHeight) * 103; // 103인 이유는 Vertical 전체가 windowHeight의 97%이기 떄문.
      if (resizeY <= 20) {
        this.uiState.updateVertical(20);
        elementControlComponent.resizeEvent();
        return false;
      }

      this.uiState.updateVertical(resizeY);
      elementControlComponent.resizeEvent();
    }
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
    if (this.isPlay) {
      return html`<button
        id="playToggle"
        class="btn btn-xs2 btn-transparent"
        @click=${this._handleClickStop}
      >
        <span class="material-symbols-outlined icon-white icon-md">
          stop_circle
        </span>
      </button>`;
    } else {
      return html`<button
        id="playToggle"
        class="btn btn-xs2 btn-transparent"
        @click=${this._handleClickPlay}
      >
        <span class="material-symbols-outlined icon-white icon-md">
          play_circle
        </span>
      </button>`;
    }
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
      <div
        class="split-bottom-bar cursor-row-resize "
        @mousedown=${this._handleClickResizeBar}
      ></div>

      <div class="row mb-2">
        <div class="col-4">
          <div class="d-flex justify-content-start">
            ${this.togglePlayButton()}
            <button
              class="btn btn-xs2 btn-transparent ms-2"
              @click=${this._handleClickReset}
            >
              <span class="material-symbols-outlined icon-white icon-md">
                replay_circle_filled
              </span>
            </button>
            <b class="text-light ms-2"
              >${new Date(this.timelineCursor).toISOString().slice(11, 22)}</b
            >
          </div>
        </div>
        <div class="d-flex col col-5 gap-2">
          <ai-input class="w-100"></ai-input>
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
