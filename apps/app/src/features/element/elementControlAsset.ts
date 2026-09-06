import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { getLocationEnv } from "../../functions/getLocationEnv";

@customElement("element-control-asset")
export class ElementControlAsset extends LitElement {
  elementControl: any;
  isDrag: boolean;
  isResize: boolean;
  isRotate: boolean;
  initialPosition: { x: number; y: number; w: number; h: number };
  resizeDirection: string;
  resizeEventHandler: any;
  rotateEventHandler: any;
  dragdownEventHandler: any;
  dragupEventHandler: any;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  /** Undoes the store subscription. See `disconnectedCallback`. */
  private unsubscribeTimeline?: () => void;

  createRenderRoot() {
    this.unsubscribeTimeline = useTimelineStore.subscribe((state) => {
      // Guarded on identity, because `timeline` is a reactive property and
      // `render()` reads it through `templateAudio`. There is one of these
      // elements per clip, so an unguarded assignment meant a Lit update per
      // clip on every store write — including the cursor ticks, which cannot
      // change the element map at all.
      if (state.timeline === this.timeline) {
        return;
      }
      this.timeline = state.timeline;
    });

    this.classList.add("d-none");
    this.style.display = "none";

    return this;
  }

  /**
   * Release the store subscription.
   *
   * There was none, and this element is created per clip and destroyed with it,
   * so the listener set grew for the life of the session — deleting a clip left
   * its listener behind, still holding the element, still running on every
   * store write. `element-control` re-renders the whole list on any timeline
   * change, so the churn was continuous.
   */
  disconnectedCallback(): void {
    this.unsubscribeTimeline?.();
    this.unsubscribeTimeline = undefined;
    super.disconnectedCallback();
  }

  @property()
  elementId;

  @property()
  elementFiletype = "image";

  constructor() {
    super();

    this.elementControl = document.querySelector("element-control");

    // this.elementId = this.getAttribute("element-id");
    // this.elementFiletype = this.getAttribute("element-filetype") || "image";

    this.isDrag = false;
    this.isResize = false;
    this.isRotate = false;

    this.initialPosition = { x: 0, y: 0, w: 0, h: 0 };
    this.resizeDirection = "n";
    this.resizeEventHandler;
    this.rotateEventHandler;
    this.dragdownEventHandler;
    this.dragupEventHandler;

    this.addEventListener("mousedown", this.handleMousedown.bind(this));
    this.addEventListener("dblclick", this.handleDoubleClick.bind(this));

    // this.addEventListener('mousedown', this.dragMousedown.bind(this));
    // this.addEventListener('mousedown', this.activateOutline.bind(this));

    document.addEventListener("mouseup", this.resizeMouseup.bind(this));
    document.addEventListener("mouseup", this.rotateMouseup.bind(this));
    document.addEventListener("mouseup", this.dragMouseup.bind(this));
  }

  render() {
    let template;
    // if (this.elementFiletype == "image") {
    //   // NOTE: this.templateRotate() 는 사이드 잘림 문제로 추후 업데이트 필요
    //   template = html`${this.templateImage()} ${this.templateResize()}`; //+ this.templateRotate()
    // } else if (this.elementFiletype == "video") {
    //   template = html`${this.templateVideo()} ${this.templateResize()}`;
    // }
    // else if (this.elementFiletype == "text") {
    //   template = html`${this.templateText()} ${this.templateResize("horizon")}`;
    // }
    if (this.elementFiletype == "audio") {
      template = html`${this.templateAudio()}`;
    }

    this.classList.add("element-drag");
    this.setAttribute("id", `element-${this.elementId}`);

    // if (this.elementFiletype !== "text") {
    //   this.setAttribute(
    //     "style",
    //     `width: ${resizeElement.w}px; top: ${resizeElement.y}px; left: ${
    //       resizeElement.x
    //     }px; height: ${resizeElement.h}px; transform: rotate(${
    //       this.timeline[this.elementId].rotation
    //     }deg);`,
    //   );
    // if (this.elementFiletype == "text") {
    //   let resizeRatio = this.elementControl.previewRatio;
    //   let resizeText = this.timeline[this.elementId].fontsize / resizeRatio;

    //   this.setAttribute(
    //     "style",
    //     `width: ${resizeElement.w}px; left: ${resizeElement.x}px; top: ${resizeElement.y}px; height: ${resizeText}px; font-size: ${resizeText}px;`,
    //   );
    //   this.elementControl.changeTextFont({
    //     elementId: this.elementId,
    //     fontPath: this.timeline[this.elementId].fontpath,
    //     fontType: this.timeline[this.elementId].fonttype,
    //     fontName: this.timeline[this.elementId].fontname,
    //   });
    // }

    //this.setPriority();

    return html`${template}`;
  }

  convertAbsoluteToRelativeSize({ x, y, w, h }: any) {
    let resizeRatio = this.elementControl.previewRatio;
    return {
      x: x / resizeRatio,
      y: y / resizeRatio,
      w: w / resizeRatio,
      h: h / resizeRatio,
    };
  }

  convertRelativeToAbsoluteSize({ x, y, w, h }: any) {
    let resizeRatio = this.elementControl.previewRatio;
    return {
      x: x * resizeRatio,
      y: y * resizeRatio,
      w: w * resizeRatio,
      h: h * resizeRatio,
    };
  }

  setPriority() {
    this.setAttribute(
      "style",
      `${this.getAttribute("style")} z-index: ${
        this.timeline[this.elementId].priority
      };`,
    );
  }

  templateAudio() {
    const element = this.timeline[this.elementId];
    if (element.filetype !== "audio") {
      return ``;
    }
    return html`<audio
      src="${this.getPath(element.localpath) || ""} "
      class="d-none"
      draggable="false"
    ></audio>`;
  }

  getPath(path) {
    const nowEnv = getLocationEnv();
    const filepath = nowEnv == "electron" ? path : `/api/file?path=${path}`;

    return filepath;
  }

  // templateText() {
  //   return html`<input-text
  //     elementId="${this.elementId}"
  //     initValue="${this.timeline[this.elementId].text || ""}"
  //     initColor="${this.timeline[this.elementId].textcolor || ""}"
  //   ></input-text>`;
  // }

  templateResize(type = "full") {
    // full horizon vertical
    let resize = {
      n: html`<div
        class="resize-n"
        onmousedown="this.parentNode.resizeMousedown('n')"
      ></div>`,
      s: html`<div
        class="resize-s"
        onmousedown="this.parentNode.resizeMousedown('s')"
      ></div>`,
      w: html`<div
        class="resize-w"
        onmousedown="this.parentNode.resizeMousedown('w')"
      ></div>`,
      e: html`<div
        class="resize-e"
        onmousedown="this.parentNode.resizeMousedown('e')"
      ></div>`,
      ne: html`<div
        class="resize-ne"
        onmousedown="this.parentNode.resizeMousedown('ne')"
      ></div>`,
      nw: html`<div
        class="resize-nw"
        onmousedown="this.parentNode.resizeMousedown('nw')"
      ></div>`,
      se: html`<div
        class="resize-se"
        onmousedown="this.parentNode.resizeMousedown('se')"
      ></div>`,
      sw: html`<div
        class="resize-sw"
        onmousedown="this.parentNode.resizeMousedown('sw')"
      ></div>`,
    };
    if (type == "full") {
      return html`
        ${resize.n} ${resize.s} ${resize.w} ${resize.e} ${resize.ne}
        ${resize.nw} ${resize.se} ${resize.sw}
      `;
    } else if (type == "vertical") {
      return html` ${resize.n} ${resize.s} `;
    } else if (type == "horizon") {
      return html` ${resize.w} ${resize.e} `;
    }
  }

  templateRotate() {
    return `<div class="handle-rotate text-center" onmousedown="this.parentNode.rotateMousedown()">
          <span class="material-symbols-outlined handle-rotate-icon">
  cached
  </span>
          </div>`;
  }

  pxToInteger(px = "0px") {
    return Number(px.split("px")[0]);
  }

  // showDragAlignmentGuide() {
  //   let dragAlignmentGuide = document.querySelector("drag-alignment-guide");
  //   let videoCanvas = document.querySelector("#video");
  //   let allowableRange = 6;

  //   let canvas = {
  //     width: Number(videoCanvas.style.width.split("px")[0]),
  //     height: Number(videoCanvas.style.height.split("px")[0]),
  //   };

  //   let elementPositions = {
  //     top: Number(this.style.top.split("px")[0]),
  //     left: Number(this.style.left.split("px")[0]),
  //     width: Number(this.style.width.split("px")[0]),
  //     height: Number(this.style.height.split("px")[0]),
  //     centerTop:
  //       Number(this.style.height.split("px")[0]) / 2 +
  //       Number(this.style.top.split("px")[0]),
  //     centerLeft:
  //       Number(this.style.width.split("px")[0]) / 2 +
  //       Number(this.style.left.split("px")[0]),
  //   };

  //   if (
  //     elementPositions.top < allowableRange &&
  //     elementPositions.top > -allowableRange
  //   ) {
  //     dragAlignmentGuide.showGuide({ position: "top" });
  //     let y = 0;
  //     this.style.top = `${y}px`;
  //     let convertLocation = this.convertRelativeToAbsoluteSize({ y: y });
  //     this.timeline[this.elementId].location.y = convertLocation.y;
  //   } else {
  //     dragAlignmentGuide.hideGuide({ position: "top" });
  //   }

  //   if (
  //     elementPositions.top + elementPositions.height >
  //       canvas.height - allowableRange &&
  //     elementPositions.top + elementPositions.height <
  //       canvas.height + allowableRange
  //   ) {
  //     dragAlignmentGuide.showGuide({ position: "bottom" });
  //     let y = canvas.height - elementPositions.height;
  //     this.style.top = `${y}px`;
  //     let convertLocation = this.convertRelativeToAbsoluteSize({ y: y });
  //     this.timeline[this.elementId].location.y = convertLocation.y;
  //   } else {
  //     dragAlignmentGuide.hideGuide({ position: "bottom" });
  //   }

  //   if (
  //     elementPositions.left < allowableRange &&
  //     elementPositions.left > -allowableRange
  //   ) {
  //     dragAlignmentGuide.showGuide({ position: "left" });
  //     let x = 0;
  //     this.style.left = `${x}px`;
  //     let convertLocation = this.convertRelativeToAbsoluteSize({ x: x });
  //     this.timeline[this.elementId].location.x = convertLocation.x;
  //   } else {
  //     dragAlignmentGuide.hideGuide({ position: "left" });
  //   }

  //   if (
  //     elementPositions.left + elementPositions.width >
  //       canvas.width - allowableRange &&
  //     elementPositions.left + elementPositions.width <
  //       canvas.width + allowableRange
  //   ) {
  //     dragAlignmentGuide.showGuide({ position: "right" });
  //     let x = canvas.width - elementPositions.width;
  //     this.style.left = `${x}px`;
  //     let convertLocation = this.convertRelativeToAbsoluteSize({ x: x });
  //     this.timeline[this.elementId].location.x = convertLocation.x;
  //   } else {
  //     dragAlignmentGuide.hideGuide({ position: "right" });
  //   }

  //   // 'horizontal', 'vertical'

  //   if (
  //     elementPositions.centerTop < canvas.height / 2 + 6 &&
  //     elementPositions.centerTop > canvas.height / 2 - 6
  //   ) {
  //     dragAlignmentGuide.showGuide({ position: "horizontal" });

  //     let y = canvas.height / 2 - elementPositions.height / 2;
  //     this.style.top = `${y}px`;
  //     let convertLocation = this.convertRelativeToAbsoluteSize({ y: y });
  //     this.timeline[this.elementId].location.y = convertLocation.y;
  //   } else {
  //     dragAlignmentGuide.hideGuide({ position: "horizontal" });
  //   }

  //   if (
  //     elementPositions.centerLeft < canvas.width / 2 + 6 &&
  //     elementPositions.centerLeft > canvas.width / 2 - 6
  //   ) {
  //     dragAlignmentGuide.showGuide({ position: "vertical" });
  //     let x = canvas.width / 2 - elementPositions.width / 2;
  //     this.style.left = `${x}px`;
  //     let convertLocation = this.convertRelativeToAbsoluteSize({ x: x });
  //     this.timeline[this.elementId].location.x = convertLocation.x;
  //   } else {
  //     dragAlignmentGuide.hideGuide({ position: "vertical" });
  //   }
  // }

  hideDragAlignmentGuide() {
    let dragAlignmentGuide = document.querySelector("drag-alignment-guide");
    dragAlignmentGuide.hideGuide({ position: "top" });
    dragAlignmentGuide.hideGuide({ position: "bottom" });
    dragAlignmentGuide.hideGuide({ position: "left" });
    dragAlignmentGuide.hideGuide({ position: "right" });
    dragAlignmentGuide.hideGuide({ position: "horizontal" });
    dragAlignmentGuide.hideGuide({ position: "vertical" });
  }

  drag(e) {
    if (this.isDrag) {
      let x = e.clientX - this.initialPosition.x;
      let y = e.clientY - this.initialPosition.y;

      let checkTagName = ["img", "video", "input"];
      let existTagName = "";
      for (let tagname = 0; tagname < checkTagName.length; tagname++) {
        if (this.querySelector(checkTagName[tagname])) {
          existTagName = checkTagName[tagname];
        }
      }

      if (x > window.innerWidth) {
        document.removeEventListener("mousemove", this.dragdownEventHandler);
      } else {
        // this.changeLocation({ x: x, y: y });

        if (this.elementFiletype == "image") {
          document.querySelector("option-image").updateValue();
        }
      }

      //this.showDragAlignmentGuide();
    }
  }

  // changeLocation({ x, y }) {
  //   this.style.top = `${y}px`;
  //   this.style.left = `${x}px`;

  //   let convertLocation = this.convertRelativeToAbsoluteSize({ x: x, y: y });

  //   this.timeline[this.elementId].location.x = convertLocation.x;
  //   this.timeline[this.elementId].location.y = convertLocation.y;
  // }

  dragMousedown(e) {
    if (!this.isResize && !this.isRotate) {
      this.isDrag = true;
      this.initialPosition.x = e.pageX - this.pxToInteger(this.style.left);
      this.initialPosition.y = e.pageY - this.pxToInteger(this.style.top);
      this.dragdownEventHandler = this.drag.bind(this);
      document.addEventListener("mousemove", this.dragdownEventHandler);
    }
  }

  dragMouseup() {
    this.hideDragAlignmentGuide();

    document.removeEventListener("mousemove", this.dragdownEventHandler);

    //NOTE: 추후에 이미지 말고 오디오, 영상의 경우 filetype 수정
    if (
      this.isDrag == true &&
      this.timeline[this.elementId].filetype == "image"
    ) {
      // this.addAnimationPoint({
      //   animationType: "position",
      // });
    }
    this.isDrag = false;
  }

  // addAnimationPoint({ animationType }) {
  //   if (
  //     this.timeline[this.elementId].animation[animationType].isActivate == false
  //   ) {
  //     return 0;
  //   }

  //   const timelineRange = Number(
  //     document.querySelector("element-timeline-range").value,
  //   );
  //   const timeMagnification = timelineRange / 4;

  //   let keyframeEditor = document.querySelector(
  //     `keyframe-editor[element-id="${this.elementId}"]`,
  //   );
  //   let progress =
  //     (this.elementControl.progressTime -
  //       this.timeline[this.elementId].startTime) /
  //     5;

  //   const addPoint = {
  //     position: () => {
  //       keyframeEditor.addPoint({
  //         x: progress,
  //         y: this.timeline[this.elementId].location.x,
  //         line: 0,
  //       });

  //       keyframeEditor.addPoint({
  //         x: progress,
  //         y: this.timeline[this.elementId].location.y,
  //         line: 1,
  //       });

  //       keyframeEditor.drawLine(0);
  //       keyframeEditor.drawLine(1);
  //     },
  //   };

  //   addPoint[animationType]();

  //   let animationPanel = document.querySelector(
  //     `animation-panel[element-id="${this.elementId}"]`,
  //   );
  //   animationPanel.updateItem();
  // }

  getGcd(a, b) {
    if (b == 0) {
      return a;
    }
    return this.getGcd(b, a % b);
  }

  // rotate(e) {
  //   this.isDrag = false;
  //   console.log("rotate", e.target.tagName);

  //   if (e.target.tagName != "CANVAS") {
  //     return 0;
  //   }

  //   let referenceRotationPoint = this.convertAbsoluteToRelativeSize({
  //     x:
  //       this.timeline[this.elementId].location.x +
  //       this.timeline[this.elementId].width / 2,
  //     y:
  //       this.timeline[this.elementId].location.y +
  //       this.timeline[this.elementId].height / 2,
  //   });

  //   let mouseX = e.offsetX;
  //   let mouseY = e.offsetY;

  //   let degree =
  //     -Math.atan2(
  //       referenceRotationPoint.x - mouseX,
  //       referenceRotationPoint.y - mouseY,
  //     ) /
  //     (Math.PI / 180);

  //   console.log();

  //   if (degree < 0) {
  //     degree = 360 + degree;
  //   }

  //   this.timeline[this.elementId].rotation = degree;
  //   this.style.transform = `rotate(${degree}deg)`;
  // }

  // resize(e) {
  //   this.isDrag = false;

  //   const videoBox = document.querySelector("#video");
  //   const rect = videoBox.getBoundingClientRect();

  //   let x = e.pageX - rect.left - this.initialPosition.x;
  //   let y = e.pageY - rect.top - this.initialPosition.y;
  //   let w = this.initialPosition.w;
  //   let h = this.initialPosition.h;

  //   let aspectRatio = w / h;

  //   switch (this.resizeDirection) {
  //     case "n":
  //       this.resizeStyle({
  //         y: this.initialPosition.y + y,
  //         h: this.initialPosition.h - y,
  //       });
  //       // this.style.top = `${this.initialPosition.y+y}px`
  //       // this.style.height = `${this.initialPosition.h-y}px`
  //       break;

  //     case "s":
  //       this.resizeStyle({
  //         y: this.initialPosition.y,
  //         h: y,
  //       });
  //       // this.style.top = `${}px`
  //       // this.style.height = `${y}px`
  //       break;

  //     case "w":
  //       this.resizeStyle({
  //         x: this.initialPosition.x + x,
  //         w: this.initialPosition.w - x,
  //       });
  //       // this.style.left = `${}px`
  //       // this.style.width = `${this.initialPosition.w-x}px`
  //       break;

  //     case "e":
  //       this.resizeStyle({
  //         x: this.initialPosition.x,
  //         w: x,
  //       });
  //       // this.style.left = `${this.initialPosition.x}px`
  //       // this.style.width = `${x}px`
  //       break;

  //     case "ne":
  //       this.resizeStyle({
  //         y: this.initialPosition.y + y,
  //         h: this.initialPosition.h - y,
  //         w: x,
  //       });
  //       // this.style.top = `${this.initialPosition.y+y}px`
  //       // //this.style.height = `${this.initialPosition.h-y}px`
  //       // //this.style.width = `${aspectRatio*(this.initialPosition.h-y)}px`
  //       // this.style.height = `${this.initialPosition.h-y}px`
  //       // this.style.width = `${x}px`

  //       break;

  //     case "nw":
  //       this.resizeStyle({
  //         x: this.initialPosition.x + x,
  //         y: this.initialPosition.y + y,
  //         h: this.initialPosition.h - y,
  //         w: this.initialPosition.w - x,
  //       });
  //       // this.style.top = `${this.initialPosition.y+y}px`
  //       // this.style.height = `${this.initialPosition.h-y}px`
  //       // this.style.left = `${this.initialPosition.x+x}px`
  //       // this.style.width = `${this.initialPosition.w-x}px`
  //       break;

  //     case "sw":
  //       this.resizeStyle({
  //         x: this.initialPosition.x + x,
  //         h: y,
  //         w: this.initialPosition.w - x,
  //       });
  //       // this.style.height = `${y}px`
  //       // this.style.left = `${this.initialPosition.x+x}px`
  //       // this.style.width = `${this.initialPosition.w-x}px`
  //       break;

  //     case "se":
  //       this.resizeStyle({
  //         x: this.initialPosition.x,
  //         y: this.initialPosition.y,
  //         h: y,
  //         w: x,
  //       });
  //       // this.style.top = `${this.initialPosition.y}px`
  //       // this.style.height = `${y}px`
  //       // this.style.left = `${this.initialPosition.x}px`
  //       // this.style.width = `${x}px`
  //       break;

  //     default:
  //       break;
  //   }
  //   let resizeRatio = this.elementControl.previewRatio;

  //   this.timeline[this.elementId].location.y = Math.round(
  //     Number(this.style.top.split("px")[0]) * resizeRatio,
  //   );
  //   this.timeline[this.elementId].location.x = Math.round(
  //     Number(this.style.left.split("px")[0]) * resizeRatio,
  //   );
  //   this.timeline[this.elementId].width = Math.round(
  //     Number(this.style.width.split("px")[0]) * resizeRatio,
  //   );
  //   this.timeline[this.elementId].height = Math.round(
  //     Number(this.style.height.split("px")[0]) * resizeRatio,
  //   );
  // }

  resizeStyle({ x, y, w, h }: any) {
    this.style.left = !x == false ? `${x}px` : this.style.left;
    this.style.top = !y == false ? `${y}px` : this.style.top;
    this.style.width = !w == false ? `${w}px` : this.style.width;
    this.style.height = !h == false ? `${h}px` : this.style.height;
  }

  // `resizeFont` used to live here. It re-committed the element's *existing*
  // font size through `changeTextSize`, which is a checkpointed store write,
  // and its only caller was `elementControl.matchAllElementsSizeToPreview` —
  // driven by a 50ms `setInterval`. It did nothing only because the
  // `input-text` overlay it guarded on has been commented out; re-enabling that
  // overlay would have filled the undo history at twenty steps a second.
  // Nothing about font size belongs on a layout pass.

  // rotateMousedown() {
  //   this.isDrag = false;
  //   this.isResize = false;

  //   if (this.isRotate == false) {
  //     this.rotateEventHandler = this.rotate.bind(this);
  //     document
  //       .querySelector("#preview")
  //       .addEventListener("mousemove", this.rotateEventHandler);
  //   }

  //   this.isRotate = true;
  // }

  rotateMouseup() {
    try {
      document
        .querySelector("#preview")
        .removeEventListener("mousemove", this.rotateEventHandler);
      this.isRotate = false;
    } catch (error) {}
  }

  resizeMousedown(direction) {
    this.isDrag = false;

    this.isResize = true;
    this.resizeDirection = direction;

    this.initialPosition.w = Number(this.style.width.split("px")[0]);
    this.initialPosition.h = Number(this.style.height.split("px")[0]);
    this.initialPosition.x = Number(this.style.left.split("px")[0]);
    this.initialPosition.y = Number(this.style.top.split("px")[0]);

    // this.resizeEventHandler = this.resize.bind(this);
    // document.addEventListener("mousemove", this.resizeEventHandler);
  }

  resizeMouseup() {
    document.removeEventListener("mousemove", this.resizeEventHandler);
    this.isResize = false;
  }

  activateOutline() {
    this.elementControl.deactivateAllOutline();
    this.elementControl.activeElementId = this.elementId;
    this.elementControl.existActiveElement = true;
    this.classList.add("element-outline");
  }

  showSideOption() {
    // let optionTab = new bootstrap.Tab(document.querySelector('#sidebar button[data-bs-target="#nav-option"]'))
    // let offcanvasOptionListsId = ['option_text']

    // for (let index = 0; index < offcanvasOptionListsId.length; index++) {
    //     const element = offcanvasOptionListsId[index];
    //     document.querySelector(`#${element}`).classList.add("d-none")
    // }

    const optionGroup = document.querySelector("option-group");
    optionGroup.showOption({
      filetype: this.elementFiletype,
      elementId: this.elementId,
    });

    // if (this.elementFiletype == 'text') {
    //     document.querySelector(`#option_text`).classList.remove("d-none")
    //     document.querySelector(`#optionTargetElement`).value = this.elementId
    //     //optionTab.show()
    // }
  }

  handleMousedown(e) {
    this.dragMousedown(e);
    this.activateOutline();
    this.showSideOption();
  }

  handleDoubleClick(e) {
    //this.showSideOption()
  }
}
