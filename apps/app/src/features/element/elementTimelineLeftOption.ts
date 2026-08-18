import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import { consume } from "@lit/context";
import { timelineContext } from "../../context/timelineContext";
import { elementUtils } from "../../utils/element";

type AnimationType = "rotation" | "position" | "opacity" | "scale";

@customElement("element-timeline-left-option")
export class ElementTimelineLeftOption extends LitElement {
  @query("#elementTimelineLeftOptionRef") canvas!: HTMLCanvasElement;

  @property({ attribute: false })
  uiState: IUIStore = uiStore.getInitialState();

  @property({ attribute: false })
  resize = this.uiState.resize;

  @property({ attribute: false })
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property({ attribute: false })
  timeline: any = this.timelineState.timeline;

  @property({ attribute: false })
  isAbleResize: boolean = false;

  @consume({ context: timelineContext })
  @property({ attribute: false })
  public timelineOptions: any = {
    canvasVerticalScroll: 0,
    panelOptions: [],
  };

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;

      //this.drawCanvas();
      this.requestUpdate();
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
    });

    window.addEventListener("mouseup", this._handleMouseUp.bind(this));
    window.addEventListener("mousemove", this._handleMouseMove.bind(this));

    return this;
  }

  private wrapText(ctx, text, x, y, maxWidth) {
    let ellipsis = "...";
    let truncatedText = text;

    if (ctx.measureText(text).width > maxWidth) {
      while (ctx.measureText(truncatedText + ellipsis).width > maxWidth) {
        truncatedText = truncatedText.slice(0, -1);
      }
      truncatedText += ellipsis;
    }

    const fontSize = 14;
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 0;
    ctx.font = `${fontSize}px "Noto Sans"`;
    ctx.fillText(truncatedText, x, y);
  }

  drawCanvas() {
    let index = 1;

    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      const dpr = window.devicePixelRatio;
      this.canvas.style.width = `${this.resize.timelineVertical.leftOption}px`;

      this.canvas.width = this.resize.timelineVertical.leftOption * dpr;
      this.canvas.height =
        document.querySelector("element-timeline").offsetHeight * dpr;

      ctx.clearRect(
        0,
        0,
        this.resize.timelineVertical.leftOption,
        this.canvas.height,
      );
      ctx.scale(dpr, dpr);

      for (const elementId in this.timeline) {
        if (Object.prototype.hasOwnProperty.call(this.timeline, elementId)) {
          const height = 30;
          const top =
            index * height * 1.2 - this.timelineOptions.canvasVerticalScroll;

          ctx.lineWidth = 0;
          ctx.fillStyle = "#292c2e";

          ctx.beginPath();
          ctx.rect(0, top, this.resize.timelineVertical.leftOption, height);
          ctx.fill();

          let splitedFilepath = this.timeline[elementId].localpath.split("/");
          let text = splitedFilepath[splitedFilepath.length - 1];

          if (this.resize.timelineVertical.leftOption > 50) {
            const fontSize = 14;
            ctx.fillStyle = "#ffffff";
            ctx.lineWidth = 0;
            ctx.font = `${fontSize}px "Noto Sans"`;
            this.wrapText(
              ctx,
              text,
              4,
              top + fontSize + 4,
              this.resize.timelineVertical.leftOption,
            );
          }

          if (
            elementUtils.getElementType(this.timeline[elementId].filetype) ==
            "static"
          ) {
            const isActive = this.isActiveAnimationPanel(elementId);
            if (isActive) {
              ctx.fillStyle = "#62a88f";
            } else {
              ctx.fillStyle = "#37485c";
            }

            if (this.timeline[elementId].filetype == "image") {
              ctx.beginPath();
              ctx.rect(
                this.resize.timelineVertical.leftOption - height,
                top,
                height,
                height,
              );
              ctx.fill();
            }

            if (isActive) {
              index += 1;
              const panelTop =
                index * height * 1.2 -
                this.timelineOptions.canvasVerticalScroll;
              ctx.fillStyle = "#62a88f";

              ctx.beginPath();
              ctx.rect(
                0,
                panelTop,
                this.resize.timelineVertical.leftOption,
                height,
              );
              ctx.fill();

              const fontSize = 14;
              ctx.fillStyle = "#ffffff";
              ctx.lineWidth = 0;
              ctx.font = `${fontSize}px "Noto Sans"`;
              this.wrapText(
                ctx,
                "Position",
                4,
                panelTop + fontSize + 4,
                this.resize.timelineVertical.leftOption,
              );
            }
          }

          index += 1;
        }
      }
    }
  }

  private drawRequestTimelineCanvas() {
    document.querySelector("element-timeline-canvas").drawCanvas();
  }

  deactivateAnimationPanel(elementId) {
    const panelOptions = this.timelineOptions.panelOptions.filter((item) => {
      return item.elementId != elementId;
    });

    this.timelineOptions.panelOptions = panelOptions;
    this.drawRequestTimelineCanvas();
  }

  activateAnimationPanel(elementId) {
    this.timelineOptions.panelOptions.push({
      elementId: elementId,
      activeAnimation: true,
    });

    this.drawRequestTimelineCanvas();
  }

  getAnimationActive(elementId, animationType: AnimationType) {
    try {
      return this.timeline[elementId].animation[animationType].isActivate;
    } catch (error) {
      return false;
    }
  }

  isActiveAnimationPanel(elementId) {
    return (
      this.timelineOptions.panelOptions.findIndex((item) => {
        return item.elementId == elementId;
      }) != -1
    );
  }

  switchActiveAnimationPanel(elementId) {
    const isActive = this.isActiveAnimationPanel(elementId);

    if (isActive) {
      this.deactivateAnimationPanel(elementId);
    } else {
      this.activateAnimationPanel(elementId);
    }

    this.requestUpdate();
  }

  activeAnimationPanel(elementId, animationType: AnimationType) {
    document
      .querySelector("element-timeline-canvas")
      .openAnimationPanel(elementId, animationType);
  }

  setActiveAnimation(elementId, animationType: AnimationType) {
    this.timeline[elementId].animation[animationType].isActivate = true;
    console.log(this.timeline[elementId]);
    this.timelineState.patchTimeline(this.timeline);
    this.requestUpdate();
  }

  setDeactivateAnimation(elementId, animationType: AnimationType) {
    console.log(this.timeline[elementId], animationType);

    this.timeline[elementId].animation[animationType].isActivate = false;
    this.timelineState.patchTimeline(this.timeline);

    this.requestUpdate();
  }

  _handleMouseMove(e) {
    const elementControlComponent = document.querySelector("element-control");

    if (this.isAbleResize) {
      const windowWidth = window.innerWidth;
      const nowX = e.clientX;
      const resizeX = nowX;

      if (resizeX <= 20) {
        this.uiState.updateTimelineVertical(20);
        elementControlComponent.resizeEvent();
        return false;
      }

      this.uiState.updateTimelineVertical(resizeX);
      elementControlComponent.resizeEvent();
    }
  }

  _handleMouseUp() {
    this.isAbleResize = false;
  }

  _handleMouseClickCanvas(e) {
    const x = e.offsetX;
    const y = e.offsetY;
    let index = 1;

    for (const elementId in this.timeline) {
      if (Object.prototype.hasOwnProperty.call(this.timeline, elementId)) {
        const height = 30;
        const top =
          index * height * 1.2 - this.timelineOptions.canvasVerticalScroll;

        if (
          x > this.resize.timelineVertical.leftOption - height &&
          x < this.resize.timelineVertical.leftOption &&
          y > top &&
          y < top + height
        ) {
          const isImage =
            elementUtils.getElementType(this.timeline[elementId].filetype) ==
            "static";

          if (!isImage) {
            index += 1;
            continue;
          }

          if (this.timeline[elementId].filetype != "image") {
            index += 1;
            continue;
          }

          const isActive = this.isActiveAnimationPanel(elementId);

          if (isActive) {
            this.deactivateAnimationPanel(elementId);
          } else {
            this.activateAnimationPanel(elementId);
          }

          this.drawCanvas();
        }

        const isActive = this.isActiveAnimationPanel(elementId);

        if (isActive) {
          index += 1;
        }

        index += 1;
      }
    }
  }

  _handleClickResizePanel() {
    this.isAbleResize = true;

    console.log("a");
  }

  protected render(): unknown {
    const dom: any = [];

    const sortedTimeline = Object.fromEntries(
      Object.entries(this.timeline).sort(
        ([, valueA]: any, [, valueB]: any) => valueA.priority - valueB.priority,
      ),
    );

    for (const key in sortedTimeline) {
      if (Object.prototype.hasOwnProperty.call(sortedTimeline, key)) {
        const element = this.timeline[key];
        let splitedFilepath = this.timeline[key].localpath.split("/");
        let text = splitedFilepath[splitedFilepath.length - 1];

        dom.push(
          html`<div
              style="position: relative; top: -${this.timelineOptions
                .canvasVerticalScroll}px;"
              class="element-left-option "
            >
              <span class="element-left-option-text">${text}</span>

              <div class="gap-1 justify-content-end">
                <button
                  class="btn btn-xxs btn-default text-light mr-2 ${element.filetype ==
                    "text" && element.parentKey != "standalone"
                    ? ""
                    : "d-none"}"
                >
                  <span class="material-symbols-outlined icon-xs"> lock </span>
                </button>
                <button
                  class="btn btn-xxs btn-default text-light mr-2 ${[
                    "image",
                    "video",
                    "text",
                  ].includes(element.filetype)
                    ? ""
                    : "d-none"}"
                  @click=${() => this.switchActiveAnimationPanel(key)}
                >
                  <span class="material-symbols-outlined icon-xs">
                    more_horiz
                  </span>
                </button>
              </div>
            </div>

            <div
              style="position: relative; top: -${this.timelineOptions
                .canvasVerticalScroll}px;"
              class="element-left-option-panel ${this.isActiveAnimationPanel(
                key,
              )
                ? ""
                : "d-none"}"
            >
              <span class="element-left-option-text">POSITION</span>

              <div class="gap-1 justify-content-end">
                <button
                  class="btn btn-xxs ${this.getAnimationActive(key, "position")
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setDeactivateAnimation(key, "position")}
                >
                  <span class="material-symbols-outlined icon-xs text-light">
                    lock_open
                  </span>
                </button>

                <button
                  class="btn btn-xxs ${this.getAnimationActive(
                    key,
                    "position",
                  ) == false
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setActiveAnimation(key, "position")}
                >
                  <span class="material-symbols-outlined icon-xs text-dark">
                    lock
                  </span>
                </button>

                <button
                  class="btn btn-xxs  text-light mr-2"
                  @click=${() => this.activeAnimationPanel(key, "position")}
                >
                  <span class="material-symbols-outlined icon-xs">
                    chevron_right
                  </span>
                </button>
              </div>
            </div>

            <div
              style="position: relative; top: -${this.timelineOptions
                .canvasVerticalScroll}px;"
              class="element-left-option-panel ${this.isActiveAnimationPanel(
                key,
              )
                ? ""
                : "d-none"}"
            >
              <span class="element-left-option-text">OPACITY</span>

              <div class="gap-1 justify-content-end">
                <button
                  class="btn btn-xxs ${this.getAnimationActive(key, "opacity")
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setDeactivateAnimation(key, "opacity")}
                >
                  <span class="material-symbols-outlined icon-xs text-light">
                    lock_open
                  </span>
                </button>

                <button
                  class="btn btn-xxs ${this.getAnimationActive(
                    key,
                    "opacity",
                  ) == false
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setActiveAnimation(key, "opacity")}
                >
                  <span class="material-symbols-outlined icon-xs text-dark">
                    lock
                  </span>
                </button>

                <button
                  class="btn btn-xxs  text-light mr-2"
                  @click=${() => this.activeAnimationPanel(key, "opacity")}
                >
                  <span class="material-symbols-outlined icon-xs">
                    chevron_right
                  </span>
                </button>
              </div>
            </div>

            <div
              style="position: relative; top: -${this.timelineOptions
                .canvasVerticalScroll}px;"
              class="element-left-option-panel ${this.isActiveAnimationPanel(
                key,
              )
                ? ""
                : "d-none"}"
            >
              <span class="element-left-option-text">SCALE</span>

              <div class="gap-1 justify-content-end">
                <button
                  class="btn btn-xxs ${this.getAnimationActive(key, "scale")
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setDeactivateAnimation(key, "scale")}
                >
                  <span class="material-symbols-outlined icon-xs text-light">
                    lock_open
                  </span>
                </button>

                <button
                  class="btn btn-xxs ${this.getAnimationActive(key, "scale") ==
                  false
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setActiveAnimation(key, "scale")}
                >
                  <span class="material-symbols-outlined icon-xs text-dark">
                    lock
                  </span>
                </button>

                <button
                  class="btn btn-xxs  text-light mr-2"
                  @click=${() => this.activeAnimationPanel(key, "scale")}
                >
                  <span class="material-symbols-outlined icon-xs">
                    chevron_right
                  </span>
                </button>
              </div>
            </div>

            <div
              style="position: relative; top: -${this.timelineOptions
                .canvasVerticalScroll}px;"
              class="element-left-option-panel ${this.isActiveAnimationPanel(
                key,
              )
                ? ""
                : "d-none"}"
            >
              <span class="element-left-option-text">ROTATION</span>

              <div class="gap-1 justify-content-end">
                <button
                  class="btn btn-xxs ${this.getAnimationActive(key, "rotation")
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setDeactivateAnimation(key, "rotation")}
                >
                  <span class="material-symbols-outlined icon-xs text-light">
                    lock_open
                  </span>
                </button>

                <button
                  class="btn btn-xxs ${this.getAnimationActive(
                    key,
                    "rotation",
                  ) == false
                    ? ""
                    : "d-none"} text-light mr-2"
                  @click=${() => this.setActiveAnimation(key, "rotation")}
                >
                  <span class="material-symbols-outlined icon-xs text-dark">
                    lock
                  </span>
                </button>

                <button
                  class="btn btn-xxs  text-light mr-2"
                  @click=${() => this.activeAnimationPanel(key, "rotation")}
                >
                  <span class="material-symbols-outlined icon-xs">
                    chevron_right
                  </span>
                </button>
              </div>
            </div> `,
        );
      }
    }

    return html`
      <style>
        .element-left-option {
          height: 30px;
          margin-bottom: 6px;
          color: #ffffff;
          background-color: #1c1f23;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 0.5rem;
        }

        .element-left-option-panel {
          height: 30px;
          margin-bottom: 6px;
          color: #ffffff;
          background-color: #505a67;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 0.5rem;
        }

        .element-left-option-text {
          color: #ececee;
          font-size: 14px;
          white-space: nowrap;
          overflow: hidden;
        }
      </style>
      <div
        style="width: ${this.resize.timelineVertical
          .leftOption}px;position: absolute; height: 100%;"
        class="tab-content"
      >
        <div
          style="height: 34px; position: relative; top: -${this.timelineOptions
            .canvasVerticalScroll}px;"
        ></div>
        ${dom}
      </div>
      <div
        class="split-col-bar"
        style="left: ${this.resize.timelineVertical.leftOption}px;"
        @mousedown=${this._handleClickResizePanel}
      ></div>
    `;
  }
}
