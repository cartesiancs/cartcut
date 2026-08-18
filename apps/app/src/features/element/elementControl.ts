import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { consume } from "@lit/context";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { decompressFrames, parseGIF } from "gifuct-js";
import { getLocationEnv } from "../../functions/getLocationEnv";

@customElement("element-control")
export class ElementControl extends LitElement {
  timelineCursor: any;
  scroller: any;
  resizeTimeout: any;
  resizeInterval: any;
  isResizeStart: boolean;
  previousPreviewSize: { w: number; h: number };
  isPaused: boolean;
  isPlay: {};
  activeElementId: string;
  selectElementsId: any[];
  existActiveElement: boolean;
  progress: number;
  progressTime: number;
  previewRatio: number;
  innerWidth: number | undefined;
  fps: number;

  @query("#elementControlCanvasRef") canvas!: HTMLCanvasElement;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline: any = this.timelineState.timeline;

  @property()
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property()
  renderOption = this.renderOptionStore.options;

  @property()
  cursor = this.timelineState.cursor;

  @property()
  startTime: any;

  @property()
  isTimelinePlay: boolean = this.timelineState.control.isPlay;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.cursor = state.cursor;
      this.progressTime = state.cursor;
      this.isTimelinePlay = state.control.isPlay;
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;

      //this.resizePreview();
    });

    return this;
  }

  constructor() {
    super();

    this.timelineCursor;

    window.addEventListener("DOMContentLoaded", () => {
      this.timelineCursor = document.querySelector("element-timeline-cursor");
      this.changeTimelineRange();
    });

    window.addEventListener("resize", () => {
      this.changeTimelineRange();
    });

    // document
    //   .querySelector("#preview")
    //   .addEventListener("click", this.handleClickPreview.bind(this));

    this.scroller = undefined;
    this.resizeTimeout = undefined;
    this.resizeInterval = undefined;

    this.isResizeStart = false;
    this.previousPreviewSize = {
      w: 1920,
      h: 1080,
    };

    this.isPaused = true;
    this.isPlay = {};
    this.fps = 60;

    this.activeElementId = "";
    this.selectElementsId = [];

    this.existActiveElement = false;

    this.progress = 0;
    this.progressTime = 0;
    this.previewRatio = 1920 / 1920;

    this.resizeEvent();
  }

  render() {
    const template: any = [];
    for (const elementId in this.timeline) {
      if (Object.prototype.hasOwnProperty.call(this.timeline, elementId)) {
        const element = this.timeline[elementId];
        template.push(
          html`<element-control-asset
            elementId="${elementId}"
            elementFiletype="${element.filetype || ""}"
          ></element-control-asset>`,
        );
      }
    }

    //this.resizePreview();

    return html`${template}`;
  }

  async resizeEvent() {
    //this.resizePreview();
    clearTimeout(this.resizeTimeout);

    if (this.isResizeStart == false) {
      this.isResizeStart = true;
      this.resizeInterval = setInterval(() => {
        this.matchAllElementsSizeToPreview();
      }, 50);
    }

    this.resizeTimeout = setTimeout(() => {
      clearInterval(this.resizeInterval);
      this.isResizeStart = false;
    }, 300);
  }

  // resizePreview() {
  //   try {
  //     let innerWidth = document.getElementById("split_col_2").offsetWidth;
  //     let splitTopHeight = document.getElementById("split_top").offsetHeight;
  //     let splitBottomHeight =
  //       document.getElementById("split_bottom").offsetHeight;
  //     let videoBoxHeight = document.getElementById("videobox").offsetHeight;
  //     let videoHeight = document.getElementById("video").offsetHeight;

  //     let elementTimelineHeight =
  //       document.querySelector("element-timeline").offsetHeight;

  //     let horizontalPadding = 0.95;
  //     let verticalPadding = 0.92;
  //     let horizontalResizeWidth = Math.round(innerWidth * horizontalPadding);
  //     let horizontalResizeHeight = Math.round(
  //       (horizontalResizeWidth * this.renderOption.previewSize.h) /
  //         this.renderOption.previewSize.w,
  //     );

  //     let verticalResizeHeight =
  //       (window.innerHeight -
  //         (splitBottomHeight + 20) -
  //         (videoBoxHeight - videoHeight)) *
  //       verticalPadding;
  //     let verticalResizeWidth =
  //       verticalResizeHeight *
  //       (this.renderOption.previewSize.w / this.renderOption.previewSize.h);

  //     let width =
  //       horizontalResizeWidth > verticalResizeWidth
  //         ? verticalResizeWidth
  //         : horizontalResizeWidth;
  //     let height =
  //       horizontalResizeHeight > verticalResizeHeight
  //         ? verticalResizeHeight
  //         : horizontalResizeHeight;

  //     let preview = document.getElementById("preview");
  //     let video = document.getElementById("video");
  //     if (preview == null) return false;
  //     if (video == null) return false;
  //     preview.setAttribute("width", String(width));
  //     preview.setAttribute("height", String(height));
  //     preview.style.width = `${width}px`;
  //     preview.style.height = `${height}px`;
  //     video.style.width = `${width}px`;
  //     video.style.height = `${height}px`;

  //     this.previewRatio = this.renderOption.previewSize.w / width;
  //   } catch (error) {}
  // }

  matchAllElementsSizeToPreview() {
    for (const elementId in this.timeline) {
      if (Object.hasOwnProperty.call(this.timeline, elementId)) {
        let targetElement = document.querySelector(`#element-${elementId}`);

        let elementHeight =
          Number(this.timeline[elementId].height) / this.previewRatio;
        let elementWidth =
          Number(this.timeline[elementId].width) / this.previewRatio;
        let elementTop =
          Number(this.timeline[elementId].location?.y) / this.previewRatio;
        let elementLeft =
          Number(this.timeline[elementId].location?.x) / this.previewRatio;

        if (this.timeline[elementId].filetype != "text") {
          targetElement.resizeStyle({
            x: elementLeft,
            y: elementTop,
            w: elementWidth,
            h: elementHeight,
          });
        } else if (this.timeline[elementId].filetype == "text") {
          let elementTextSize =
            Number(this.timeline[elementId].fontsize) / this.previewRatio;

          targetElement.resizeStyle({
            x: elementLeft,
            y: elementTop,
            w: elementWidth,
            h: elementHeight,
          });

          targetElement.resizeFont({
            px: elementTextSize,
          });
        }
      }
    }
  }

  // removeElementById(elementId) {

  //   this.querySelector(
  //     `element-control-asset[element-id="${elementId}"]`,
  //   ).remove();
  //   this.timeline = document.querySelector("element-timeline").timeline;
  // }

  removeAllElementAsset() {
    const assetLists = this.querySelectorAll("element-control-asset");
    assetLists.forEach((element) => {
      element.remove();
    });
    this.timeline = document.querySelector("element-timeline").timeline;
  }

  fitElementSizeOnPreview(width, height) {
    // The preview canvas is a viewport now — its backing store is the visible
    // area in device pixels, not the project resolution. Read the resolution
    // from the store instead.
    const previewSize = renderOptionStore.getState().options.previewSize;
    let preview = {
      w: Number(previewSize.w),
      h: Number(previewSize.h),
    };

    let originRatio = width / height;
    let resizeHeight = height < preview.h ? height : preview.h;
    let resizeWidth = resizeHeight * originRatio;

    return {
      width: resizeWidth,
      height: resizeHeight,
    };
  }

  getNowPriority() {
    if (Object.keys(this.timeline).length == 0) {
      return 1;
    }

    let lastPriority: any = 1;

    for (const key in this.timeline) {
      if (Object.hasOwnProperty.call(this.timeline, key)) {
        const element = this.timeline[key];
        lastPriority =
          lastPriority < (element.priority as number)
            ? element.priority
            : lastPriority;
      }
    }

    return lastPriority + 1;
  }

  addImage(blob, path) {
    const elementId = this.generateUUID();
    const img = document.createElement("img");

    img.src = blob;
    img.onload = () => {
      let resize = this.fitElementSizeOnPreview(img.width, img.height);
      let width = resize.width;
      let height = resize.height; // /division

      const nowEnv = getLocationEnv();
      const filepath = nowEnv == "electron" ? path : `/api/file?path=${path}`;

      this.timeline[elementId] = {
        priority: this.getNowPriority(),
        blob: blob,
        startTime: 0,
        duration: 1000,
        opacity: 100,
        location: { x: 0, y: 0 },
        rotation: 0,
        width: width,
        height: height,
        localpath: path,
        filetype: "image",
        ratio: img.width / img.height,
        animation: {
          position: {
            isActivate: false,
            x: [],
            y: [],
            ax: [[], []],
            ay: [[], []],
          },
          opacity: {
            isActivate: false,
            x: [],
            ax: [[], []],
          },
          scale: {
            isActivate: false,
            x: [],
            ax: [[], []],
          },
          rotation: {
            isActivate: false,
            x: [],
            ax: [[], []],
          },
        },
        timelineOptions: {
          color: "rgb(134, 41, 143)",
        },
      };

      this.timelineState.patchTimeline(this.timeline);
      this.timelineState.checkPointTimeline();
    };
  }

  addGif(blob, path) {
    const elementId = this.generateUUID();
    const img = document.createElement("img");

    const nowEnv = getLocationEnv();
    const filepath = nowEnv == "electron" ? path : `/api/file?path=${path}`;

    fetch(filepath)
      .then((resp) => resp.arrayBuffer())
      .then((buff) => {
        let gif = parseGIF(buff);
        let frames = decompressFrames(gif, true);
        this.timeline[elementId] = {
          priority: this.getNowPriority(),
          blob: blob,
          startTime: 0,
          duration: 1000,
          opacity: 100,
          location: { x: 0, y: 0 },
          rotation: 0,
          width: frames[0].dims.width,
          height: frames[0].dims.height,
          localpath: path,
          filetype: "gif",
          ratio: frames[0].dims.width / frames[0].dims.height,
          timelineOptions: {
            color: "rgb(134, 41, 143)",
          },
        };

        this.timelineState.patchTimeline(this.timeline);
        this.timelineState.checkPointTimeline();
      });
  }

  addVideo(blob, path) {
    const elementId = this.generateUUID();
    const video = document.createElement("video");
    const toastMetadata = bootstrap.Toast.getInstance(
      document.getElementById("loadMetadataToast"),
    );
    toastMetadata.show();

    video.src = blob;
    video.preload = "metadata";

    video.onloadedmetadata = () => {
      let width = video.videoWidth;
      let height = video.videoHeight;
      let duration = video.duration * 1000;

      window.electronAPI.req.ffmpeg.getMetadata(blob, path).then((result) => {
        let blobdata = result.blobdata;
        let metadata = result.metadata;
        console.log(metadata);

        let isExist = false;

        setTimeout(() => {
          toastMetadata.hide();
        }, 1000);

        metadata.streams.forEach((element) => {
          if (element.codec_type == "audio") {
            isExist = true;
          }
        });

        const nowEnv = getLocationEnv();
        const filepath = nowEnv == "electron" ? path : `/api/file?path=${path}`;

        this.timeline[elementId] = {
          priority: this.getNowPriority(),
          blob: blob,
          startTime: 0,
          duration: duration,
          opacity: 100,
          location: { x: 0, y: 0 },
          trim: { startTime: 0, endTime: duration },
          rotation: 0,
          width: width,
          height: height,
          ratio: width / height,
          localpath: path,
          isExistAudio: isExist,
          filetype: "video",
          codec: { video: "default", audio: "default" },
          speed: 1,
          filter: {
            enable: false,
            list: [],
          },
          origin: {
            width: width,
            height: height,
          },
          animation: {
            position: {
              isActivate: false,
              x: [],
              y: [],
              ax: [[], []],
              ay: [[], []],
            },
            opacity: {
              isActivate: false,
              x: [],
              ax: [[], []],
            },
            scale: {
              isActivate: false,
              x: [],
              ax: [[], []],
            },
            rotation: {
              isActivate: false,
              x: [],
              ax: [[], []],
            },
          },
          timelineOptions: {
            color: "rgb(71, 59, 179)",
          },
        };

        this.timelineState.patchTimeline(this.timeline);
        this.timelineState.checkPointTimeline();

        // this.showVideo(elementId);
      });

      // ffmpeg.ffprobe(path, (err, metadata) => {

      // })
    };
  }

  // NOTE: 영상 레코딩시 사용됩니다. 추후 리팩토링 필요합니다.
  addVideoWithDuration(blob, path, duration) {
    const elementId = this.generateUUID();
    const video = document.createElement("video");
    const toastMetadata = bootstrap.Toast.getInstance(
      document.getElementById("loadMetadataToast"),
    );
    toastMetadata.show();

    video.src = blob;
    video.preload = "metadata";

    video.onloadedmetadata = () => {
      let width = video.videoWidth;
      let height = video.videoHeight;

      window.electronAPI.req.ffmpeg.getMetadata(blob, path);

      window.electronAPI.res.ffmpeg.getMetadata((evt, blobdata, metadata) => {
        if (blobdata != blob) {
          return 0;
        }

        let isExist = false;

        setTimeout(() => {
          toastMetadata.hide();
        }, 1000);

        metadata.streams.forEach((element) => {
          if (element.codec_type == "audio") {
            isExist = true;
          }
        });

        this.timeline[elementId] = {
          priority: this.getNowPriority(),
          blob: blob,
          startTime: 0,
          duration: duration,
          opacity: 100,
          location: { x: 0, y: 0 },
          trim: { startTime: 0, endTime: duration },
          rotation: 0,
          width: width,
          height: height,
          ratio: width / height,
          localpath: path,
          isExistAudio: isExist,
          filetype: "video",
          codec: { video: "default", audio: "default" },
          speed: 1,
          filter: {
            enable: false,
            list: [],
          },
          origin: {
            width: width,
            height: height,
          },
          animation: {
            position: {
              isActivate: false,
              x: [],
              y: [],
              ax: [[], []],
              ay: [[], []],
            },
            opacity: {
              isActivate: false,
              x: [],
              ax: [[], []],
            },
            scale: {
              isActivate: false,
              x: [],
              ax: [[], []],
            },
            rotation: {
              isActivate: false,
              x: [],
              ax: [[], []],
            },
          },
          timelineOptions: {
            color: "rgb(71, 59, 179)",
          },
        };

        this.timelineState.patchTimeline(this.timeline);
        this.timelineState.checkPointTimeline();

        // this.showVideo(elementId);
      });
    };
  }

  addText({
    parentKey = "standalone",
    text = "TITLE",
    textcolor = "#ffffff",
    fontsize = 52,
    optionsAlign = "left",
    backgroundEnable = false,
    locationX = 0,
    locationY = 0,
    height = 66,
    width = 500,
    startTime = 0,
    duration = 1000,
  }) {
    const elementId = this.generateUUID();

    this.timeline[elementId] = {
      parentKey: parentKey,
      priority: this.getNowPriority(),
      startTime: startTime,
      duration: duration,
      text: text,
      textcolor: textcolor,
      fontsize: fontsize,
      fontpath: "default",
      fontname: "notosanskr",
      fontweight: "medium",
      fonttype: "otf",
      letterSpacing: 0,
      options: {
        isBold: false,
        isItalic: false,
        align: optionsAlign,
        outline: {
          enable: false,
          size: 1,
          color: "#000000",
        },
      },
      background: {
        enable: backgroundEnable,
        color: "#000000",
      },
      location: { x: locationX, y: locationY },
      rotation: 0,
      localpath: "/TEXTELEMENT",
      filetype: "text",
      height: height,
      width: width,
      widthInner: 200,
      opacity: 100,
      animation: {
        position: {
          isActivate: false,
          x: [],
          y: [],
          ax: [[], []],
          ay: [[], []],
        },
        opacity: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        scale: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        rotation: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
      },
      timelineOptions: {
        color: "rgb(59, 143, 179)",
      },
    };

    this.timelineState.patchTimeline(this.timeline);
    this.timelineState.checkPointTimeline();

    // this.showText(elementId);
    // this.elementTimeline.addElementBar(elementId);
  }

  // NOTE: 삭제 필요
  addCustomText(font: { path: string; name: string }) {
    const elementId = this.generateUUID();
    const fontSize = 52;

    this.timeline[elementId] = {
      parentKey: "standalone",
      priority: this.getNowPriority(),
      startTime: 0,
      duration: 1000,
      text: "TITLE",
      textcolor: "#ffffff",
      fontsize: fontSize,
      fontpath: font.path,
      fontname: font.name,
      fontweight: "medium",
      fonttype: "otf",
      letterSpacing: 0,
      opacity: 100,
      options: {
        isBold: false,
        isItalic: false,
        align: "left",
        outline: {
          enable: false,
          size: 1,
          color: "#000000",
        },
      },
      background: {
        enable: false,
        color: "#000000",
      },
      location: { x: 0, y: 0 },
      rotation: 0,
      localpath: "/TEXTELEMENT",
      filetype: "text",
      height: fontSize + 16,
      width: 500,
      widthInner: 200,
      animation: {
        position: {
          isActivate: false,
          x: [],
          y: [],
          ax: [[], []],
          ay: [[], []],
        },
        opacity: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        scale: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        rotation: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
      },
      timelineOptions: {
        color: "rgb(59, 143, 179)",
      },
    };

    this.timelineState.patchTimeline(this.timeline);
    this.timelineState.checkPointTimeline();

    // this.showText(elementId);
    // this.elementTimeline.addElementBar(elementId);
  }

  addAudio(blob, path) {
    const elementId = this.generateUUID();
    const audio = document.createElement("audio");

    const nowEnv = getLocationEnv();
    const filepath = nowEnv == "electron" ? path : `/api/file?path=${path}`;

    audio.src = blob;

    audio.onloadedmetadata = () => {
      let duration = audio.duration * 1000;

      this.timeline[elementId] = {
        priority: this.getNowPriority(),
        blob: blob,
        startTime: 0,
        duration: duration,
        location: { x: 0, y: 0 }, // NOT USING
        trim: { startTime: 0, endTime: duration },
        localpath: path,
        filetype: "audio",
        speed: 1,
        timelineOptions: {
          color: "rgb(133, 179, 59)",
        },
      };

      this.timelineState.patchTimeline(this.timeline);
      this.timelineState.checkPointTimeline();

      // this.showAudio(elementId);
      // this.elementTimeline.addElementBar(elementId);
    };
  }

  addAudioWithDuration(blob, path, duration) {
    const elementId = this.generateUUID();
    const audio = document.createElement("audio");

    this.timeline[elementId] = {
      priority: this.getNowPriority(),
      blob: blob,
      startTime: 0,
      duration: duration,
      location: { x: 0, y: 0 }, // NOT USING
      trim: { startTime: 0, endTime: duration },
      localpath: path,
      filetype: "audio",
      speed: 1,
      timelineOptions: {
        color: "rgb(133, 179, 59)",
      },
    };

    this.timelineState.patchTimeline(this.timeline);
    this.timelineState.checkPointTimeline();
  }

  // showAnimation(elementId, animationType) {
  //   let index = Math.round(this.progressTime / 16);
  //   let indexToMs = index * 20;
  //   let startTime = Number(this.timeline[elementId].startTime);
  //   let indexPoint = Math.round((indexToMs - startTime) / 20);

  //   try {
  //     if (indexPoint < 0) {
  //       return 0;
  //     }

  //     const x = this.findNearestY(
  //       this.timeline[elementId].animation[animationType].ax,
  //       this.progressTime - this.timeline[elementId].startTime,
  //     );

  //     const y = this.findNearestY(
  //       this.timeline[elementId].animation[animationType].ay,
  //       this.progressTime - this.timeline[elementId].startTime,
  //     );

  //     document.querySelector(`#element-${elementId}`).style.left = `${
  //       x / this.previewRatio
  //     }px`;
  //     document.querySelector(`#element-${elementId}`).style.top = `${
  //       y / this.previewRatio
  //     }px`;
  //   } catch (error) {}
  // }

  // showImage(elementId) {
  //   if (document.getElementById(`element-${elementId}`) == null) {
  //     this.insertAdjacentHTML(
  //       "beforeend",
  //       `<element-control-asset element-id="${elementId}" element-filetype="image"></element-control-asset>`,
  //     );
  //   } else {
  //     document
  //       .querySelector(`#element-${elementId}`)
  //       .classList.remove("d-none");
  //   }

  //   let animationType = "position";
  //   if (this.timeline[elementId].animation[animationType].isActivate == true) {
  //     this.showAnimation(elementId, animationType);
  //   }
  // }

  // showVideo(elementId) {
  //   const element: any = document.getElementById(`element-${elementId}`);
  //   if (element == null) {
  //     this.insertAdjacentHTML(
  //       "beforeend",
  //       `<element-control-asset elementId="${elementId}" elementFiletype="video"></element-control-asset>`,
  //     );

  //     let video = element.querySelector("video");
  //     video.muted = true;

  //     let secondsOfRelativeTime =
  //       ((this.timeline[elementId].startTime as number) - this.progressTime) /
  //       1000;

  //     video.currentTime = secondsOfRelativeTime;
  //   } else {
  //     const videoElement: any = document.getElementById(`element-${elementId}`);

  //     let video = videoElement.querySelector("video");
  //     let secondsOfRelativeTime =
  //       -((this.timeline[elementId].startTime as number) - this.progressTime) /
  //       1000;

  //     if (
  //       !!(
  //         video.currentTime > 0 &&
  //         !video.paused &&
  //         !video.ended &&
  //         video.readyState > 2
  //       )
  //     ) {
  //       if (this.isPaused) {
  //         console.log("paused");
  //       }
  //     } else {
  //       if (this.isPaused) {
  //         video.pause();
  //         this.isPlay[elementId] = false;
  //       } else {
  //         if (!this.isPlay[elementId]) {
  //           video.currentTime = secondsOfRelativeTime;
  //           video.muted = true;
  //           video.play();
  //         }
  //         this.isPlay[elementId] = true;
  //       }
  //     }

  //     document
  //       .querySelector(`#element-${elementId}`)
  //       .classList.remove("d-none");
  //   }
  // }

  showAudio(elementId) {
    const element: any = document.getElementById(`element-${elementId}`);

    if (element == null) {
      this.insertAdjacentHTML(
        "beforeend",
        `<element-control-asset element-id="${elementId}" element-filetype="audio"></element-control-asset>`,
      );

      let audio = element.querySelector("audio");
      let secondsOfRelativeTime =
        ((this.timeline[elementId].startTime as number) - this.progressTime) /
        1000;

      audio.currentTime = secondsOfRelativeTime;
    } else {
      let audio = element.querySelector("audio");
      let secondsOfRelativeTime =
        -((this.timeline[elementId].startTime as number) - this.progressTime) /
        1000;

      if (
        !!(
          audio.currentTime > 0 &&
          !audio.paused &&
          !audio.ended &&
          audio.readyState > 2
        )
      ) {
      } else {
        audio.currentTime = secondsOfRelativeTime;

        if (this.isPaused) {
          audio.pause();
        } else {
          audio.play();
        }
      }

      document
        .querySelector(`#element-${elementId}`)
        .classList.remove("d-none");
    }
  }

  // showText(elementId) {
  //   if (document.getElementById(`element-${elementId}`) == null) {
  //     this.insertAdjacentHTML(
  //       "beforeend",
  //       `<element-control-asset element-id="${elementId}" element-filetype="text"></element-control-asset>`,
  //     );
  //   }
  //   if (
  //     this.timeline[elementId].animation["position"].isActivate == true &&
  //     this.timeline[elementId].animation["position"].allpoints.length >
  //       document.querySelector("element-control").progress
  //   ) {
  //     this.showAnimation(elementId, "position");
  //   }
  // }

  changeText(elementId) {
    //this.timeline[elementId].text = inputValue;
  }

  changeTextValue({ elementId, value }) {
    this.timeline[elementId].text = value;
    this.timelineState.patchTimeline(this.timeline);
  }

  changeTextColor({ elementId, color }) {
    this.timeline[elementId].textcolor = color;
    this.timelineState.patchTimeline(this.timeline);
  }

  changeTextSize({ elementId, size }) {
    try {
      this.timeline[elementId].fontsize = Number(size);
      this.timeline[elementId].height = Number(size) + 16;
      this.timelineState.patchTimeline(this.timeline);
    } catch (error) {
      console.log(error);
    }
  }

  changeTextFont({ elementId, fontPath, fontType, fontName }) {
    this.timeline[elementId].fontpath = fontPath;
    this.timeline[elementId].fontname = fontName;
    this.timelineState.patchTimeline(this.timeline);
  }

  changeTimelineRange() {
    const cursorDom = document.querySelector("element-timeline-cursor");

    const timelineRange = Number(
      document.querySelector("element-timeline-range").value,
    );
    const timeMagnification = timelineRange / 4;

    if (timelineRange == 0) {
      return 0;
    }

    cursorDom.style.left = `${(this.progressTime / 5) * timeMagnification}px`;
    // this.adjustAllElementBarWidth(timeMagnification);
    //this.updateAllAnimationPanel();
  }

  // updateAllAnimationPanel() {
  //   for (const elementId in this.timeline) {
  //     if (Object.hasOwnProperty.call(this.timeline, elementId)) {
  //       const element = this.timeline[elementId];

  //       if (element.filetype != "image") {
  //         continue;
  //       }

  //       if (element.animation.position.isActivate == false) {
  //         continue;
  //       }

  //       let targetAnimationPanel = document.querySelector(
  //         `animation-panel[element-id="${elementId}"]`,
  //       );
  //       let targetElementBar = document.querySelector(
  //         `element-bar[element-id="${elementId}"]`,
  //       );

  //       let originalLeft = targetElementBar.millisecondsToPx(
  //         this.timeline[elementId].startTime,
  //       );

  //       targetAnimationPanel.updateItem();
  //       targetElementBar.animationPanelMove(originalLeft);
  //     }
  //   }
  // }

  getTimeFromProgress() {
    let timelineRange = Number(
      document.querySelector("element-timeline-range").value,
    );
    let timeMagnification = timelineRange / 4;

    let relativeMilliseconds = this.progress * 5;
    let absoluteMilliseconds = relativeMilliseconds / timeMagnification;
    return absoluteMilliseconds;
  }

  getTimeFromTimelineBar() {
    let timelineCursorProgress = Number(
      this.timelineCursor.style.left.split("px")[0],
    );
    let timelineRange = Number(
      document.querySelector("element-timeline-range").value,
    );
    let timeMagnification = timelineRange / 4;

    let milliseconds = (timelineCursorProgress * 5) / timeMagnification;
    return milliseconds;
  }

  // adjustAllElementBarWidth(ratio) {
  //   const allElementBar = document.querySelectorAll("element-bar");
  //   allElementBar.forEach((element: any) => {
  //     let elementId = element.getAttribute("element-id");
  //     let originalWidth = element.millisecondsToPx(
  //       this.timeline[elementId].duration,
  //     );
  //     let originalLeft = element.millisecondsToPx(
  //       this.timeline[elementId].startTime,
  //     );
  //     let changedWidth = originalWidth;
  //     let changedLeft = originalLeft;

  //     element.setWidth(changedWidth);
  //     element.setLeft(changedLeft);

  //     if (element.elementBarType == "dynamic") {
  //       let trimStart = element.millisecondsToPx(
  //         this.timeline[elementId].trim.startTime,
  //       );
  //       let trimEnd = element.millisecondsToPx(
  //         this.timeline[elementId].duration -
  //           this.timeline[elementId].trim.endTime,
  //       );

  //       element.setTrimStart(trimStart);
  //       element.setTrimEnd(trimEnd);
  //     }
  //   });
  // }

  getMillisecondsToISOTime(milliseconds) {
    let time = new Date(milliseconds).toISOString().slice(11, 22);
    return time;
  }

  progressToTime() {
    let ms = this.progress * 5;
    let time = new Date(ms).toISOString().slice(11, 22);
    return time;
  }

  generateUUID() {
    let uuid = uuidv4();
    return uuid;
  }

  hideElement(elementId) {
    if (this.timeline[elementId].filetype == "video") {
      this.pauseVideo(elementId);
    } else if (this.timeline[elementId].filetype == "audio") {
      this.pauseAudio(elementId);
    }
    // document.querySelector(`#element-${elementId}`).classList.add("d-none");
  }

  appearAllElementInTime() {
    for (let elementId in this.timeline) {
      let filetype = this.timeline[elementId].filetype;
      // Visibility depends ONLY on timeline position (startTime + duration)
      // NOT on trim values (which are source file positions for FFmpeg -ss seeking)
      let checkFiletype =
        (this.timeline[elementId].startTime as number) > this.progressTime ||
        (this.timeline[elementId].startTime as number) +
          (this.timeline[elementId].duration as number) <
          this.progressTime;

      if (checkFiletype) {
        this.hideElement(elementId);
      } else {
        if (filetype == "image") {
          //this.showImage(elementId);
        } else if (filetype == "video") {
          // this.showVideo(elementId);
        } else if (filetype == "text") {
          // this.showText(elementId);
        } else if (filetype == "audio") {
          this.showAudio(elementId);
        }
      }
    }
  }

  step() {
    const elapsed = Date.now() - this.startTime;

    let nowTimelineRange = Number(
      document.querySelector("element-timeline-range").value,
    );
    let nowTimelineProgress =
      Number(this.timelineCursor.style.left.split("px")[0]) + nowTimelineRange;

    this.progress = nowTimelineProgress;
    this.progressTime = elapsed;
    this.timelineState.setCursor(elapsed);

    if ((this.innerWidth as number) + this.offsetWidth >= this.offsetWidth) {
      this.stop();
    }

    this.appearAllElementInTime();

    this.scroller = window.requestAnimationFrame(this.step.bind(this));
  }

  play() {
    const previewCanvas = document.querySelector("preview-canvas");
    previewCanvas.startPlay();

    this.scroller = window.requestAnimationFrame(this.step.bind(this));
    this.startTime = Date.now() - this.progressTime;
    this.isPaused = false;
  }

  stop() {
    cancelAnimationFrame(this.scroller);

    const previewCanvas = document.querySelector("preview-canvas");
    previewCanvas.stopPlay();

    this.isPaused = true;
    for (const elementId in this.timeline) {
      if (Object.hasOwnProperty.call(this.timeline, elementId)) {
        this.isPlay[elementId] = false;
      }
    }

    this.pauseAllDynamicElements();
  }

  reset() {
    const previewCanvas = document.querySelector("preview-canvas");
    previewCanvas.stopPlay();

    this.progress = 0;
    this.progressTime = 0;
    this.stop();

    this.appearAllElementInTime();

    this.timelineState.setCursor(0);
  }

  pauseVideo(elementId) {
    // const target: any = document.getElementById(`element-${elementId}`);
    // let secondsOfRelativeTime =
    //   -((this.timeline[elementId].startTime as number) - this.progressTime) /
    //   1000;
    // let video = target.querySelector("video");
    // video.currentTime = secondsOfRelativeTime;
    // video.pause();
  }

  pauseAudio(elementId) {
    const target: any = document.getElementById(`element-${elementId}`);

    let audio = target.querySelector("audio");
    audio.pause();
  }

  pauseAllDynamicElements() {
    let key;

    for (key in this.timeline) {
      let filetype = this.timeline[key].filetype;

      if (filetype == "video") {
        this.pauseVideo(key);
      } else if (filetype == "audio") {
        this.pauseAudio(key);
      }
    }
  }

  deactivateAllOutline() {
    for (const elementId in this.timeline) {
      if (Object.hasOwnProperty.call(this.timeline, elementId)) {
        document
          .querySelector(`#element-${elementId}`)
          .classList.remove("element-outline");
      }
    }
    this.activeElementId = "";
    this.existActiveElement = false;
  }

  // handleClickPreview() {
  //   this.deactivateAllOutline();
  // }
}

@customElement("drag-alignment-guide")
export class DragAlignmentGuide extends LitElement {
  videoCanvas: any;
  allPositions: string[];
  constructor() {
    super();

    this.videoCanvas = document.querySelector("#video");
    this.allPositions = [
      "top",
      "bottom",
      "left",
      "right",
      "horizontal",
      "vertical",
    ];
  }

  addGuide() {
    for (let index = 0; index < this.allPositions.length; index++) {
      const position = this.allPositions[index];
      document
        .querySelector("#video")
        .insertAdjacentHTML(
          "beforeend",
          `<alignment-guide position="${position}" class="alignment-guide alignment-guide-${position}"></alignment-guide>`,
        );
      this.hideGuide({ position: position });
    }
  }

  hideGuide({ position }) {
    let target = document
      .querySelector("#video")
      .querySelector(`alignment-guide[position='${position}']`);
    target.classList.add("d-none");
  }

  showGuide({ position }) {
    let target = document
      .querySelector("#video")
      .querySelector(`alignment-guide[position='${position}']`);
    target.classList.remove("d-none");
  }

  connectedCallback() {
    this.addGuide();
  }
}
