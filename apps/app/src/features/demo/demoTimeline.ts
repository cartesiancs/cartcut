import { emptyAnimation } from "../animation/keyframes";
import { LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { useTimelineStore } from "../../states/timelineStore";
import { placeNewElement } from "../timeline/placement";
import {
  linkedTemplateSlug,
  openLinkedTemplate,
} from "../template/templateLinkBrowser";

/**
 * How long `/sample/106366-673007941.mp4` is: 596 frames at 60fps, 9933.33ms
 * by both ffprobe and Chromium. The preset used to claim 60000, so the clip ran
 * fifty seconds past the file's last frame.
 */
const SAMPLE_VIDEO_MS = 9933;

/**
 * The public demo's starting timeline: a sample clip, a still and a title,
 * placed once on the first update, or the example template the page address
 * names (`template/templateLink.ts`). Draws nothing.
 */
@customElement("demo-timeline")
export class DemoTimeline extends LitElement {
  createRenderRoot() {
    return this;
  }

  firstUpdated() {
    const env = getLocationEnv();
    // A link naming an example template opens that instead of the preset, in
    // either browser build: `/?template=<slug>`.
    const slug = env === "electron" ? null : linkedTemplateSlug();
    if (slug != null) {
      void this.openTemplate(slug);
      return;
    }
    if (env == "demo") {
      this.insertPresetTimeline();
    }
  }

  private async openTemplate(slug: string) {
    const result = await openLinkedTemplate(slug);
    if (!result.ok) {
      (document.querySelector("toast-box") as any)?.showToast({
        message: result.message,
        delay: "6000",
      });
    }
  }

  private insertPresetTimeline() {
    const elements: Record<string, unknown> = {
      "af9bb3d9-f9cc-4ec0-a768-cb818fbbe033": {
        // `priority` is omitted throughout: placement derives it from the
        // track each element lands on.
        blob: "blob:file:///668d3bda-547a-4bb6-ab7a-53cc1c8000ef",
        startTime: 0,
        duration: SAMPLE_VIDEO_MS,
        opacity: 100,
        location: {
          x: 0,
          y: 0,
        },
        trim: {
          startTime: 0,
          endTime: SAMPLE_VIDEO_MS,
        },
        sourceDuration: SAMPLE_VIDEO_MS,
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
        animation: emptyAnimation("video"),
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
        animation: emptyAnimation("image"),
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
        animation: emptyAnimation("text"),
      },
    };

    // The preset is authored as a bare element map with no tracks, so route it
    // through the same placement rule the editor uses. Each element keeps its
    // own start time and lands on a track of the right kind: the video and the
    // still overlap in time, so they end up stacked rather than sharing a row.
    useTimelineStore.getState().withCheckpoint((doc) => {
      let next = doc;
      for (const [elementId, element] of Object.entries(elements)) {
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
  }
}
