import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { placeNewElement } from "../timeline/placement";

@customElement("warning-demo")
export class WarningDemo extends LitElement {
  hasUpdatedOnce: boolean;
  showWarn: any;

  @query("#showDemoWarn")
  modalEl;

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline: any = this.timelineState.timeline;

  constructor() {
    super();
    this.hasUpdatedOnce = false;
  }

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
    });

    return this;
  }

  updated() {
    if (!this.hasUpdatedOnce) {
      if (this.modalEl) {
        const myModal = new bootstrap.Modal(this.modalEl);
        if (getLocationEnv() == "demo") {
          this.insertPresetTimeline();

          myModal.show();
        }
      } else {
        console.error("Modal element not found in shadow DOM.");
      }

      this.hasUpdatedOnce = true;
    }
  }

  insertPresetTimeline() {
    this.timeline = {
      "af9bb3d9-f9cc-4ec0-a768-cb818fbbe033": {
        // `priority` is omitted throughout: placement derives it from the
        // track each element lands on.
        blob: "blob:file:///668d3bda-547a-4bb6-ab7a-53cc1c8000ef",
        startTime: 0,
        duration: 60000,
        opacity: 100,
        location: {
          x: 0,
          y: 0,
        },
        trim: {
          startTime: 0,
          endTime: 60000,
        },
        sourceDuration: 60000,
        rotation: 0,
        width: 1920,
        height: 1080,
        ratio: 1.7777777777777777,
        localpath: "/sample/106366-673007941.mp4",
        isExistAudio: false,
        filetype: "video",
        codec: {
          video: "default",
          audio: "default",
        },
        speed: 1,
        filter: {
          enable: false,
          list: [],
        },
        origin: {
          width: 1920,
          height: 1080,
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
      },
      "f395b92c-c195-42d7-bc90-f62b62f3000d": {
        blob: "blob:file:///ac05f4bc-7c0b-456f-ae60-87b251f6f38d",
        startTime: 2956,
        duration: 3467,
        opacity: 100,
        location: {
          x: 746.1600257858546,
          y: 158.24941841826205,
        },
        rotation: 0,
        width: 427.6799484282908,
        height: 763.5011631634759,
        localpath: "/sample/developer-8764521_1280.jpg",
        filetype: "image",
        ratio: 0.56015625,
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
      },
      "b33c8a40-1e3b-456c-b84f-bbb01cb75a6c": {
        isBold: false,
        isItalic: false,
        align: "center",
        outline: {
          enable: false,
          size: 1,
          color: "#000000",
        },
        startTime: 556,
        duration: 1533,
        text: "TEST TITLE",
        textcolor: "#ffffff",
        fontsize: 52,
        fontpath: "default",
        fontname: "notosanskr",
        fontweight: "medium",
        fonttype: "otf",
        letterSpacing: 0,
        options: {
          isBold: false,
          isItalic: false,
          align: "center",
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
        location: {
          x: 710,
          y: 507,
        },
        rotation: 0,
        localpath: "/TEXTELEMENT",
        filetype: "text",
        height: 66,
        width: 500,
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
      },
    };

    // The preset is authored as a bare element map with no tracks, so route it
    // through the same placement rule the editor uses. Each element keeps its
    // own start time and lands on a track of the right kind — the video and the
    // still overlap in time, so they end up stacked rather than sharing a row.
    this.timelineState.withCheckpoint((doc) => {
      let next = doc;
      for (const [elementId, element] of Object.entries(this.timeline)) {
        next = placeNewElement(
          next,
          elementId,
          element as any,
          (element as any).startTime,
          uuidv4(),
        );
      }
      return next;
    });

    this.timeline = useTimelineStore.getState().timeline;
  }

  render() {
    return html` <div
      class="modal fade"
      id="showDemoWarn"
      tabindex="-1"
      aria-hidden="true"
    >
      <div class="modal-dialog modal-dialog-dark modal-dialog-centered">
        <div class="modal-content modal-dark modal-darker">
          <div class="modal-body modal-body-dark">
            <h6 class="modal-title text-light font-weight-lg mb-2">
              Nugget Demo Version
            </h6>

            <span class="text-light"
              >The results edited in the demo version cannot be
              <b class="text-danger">exported.</b> Please use the Electron
              installation version or use the host version from another
              provider.
            </span>

            <br />

            <button data-bs-dismiss="modal" class="btn btn-danger btn-sm mt-2">
              Process
            </button>
          </div>
        </div>
      </div>
    </div>`;
  }
}
