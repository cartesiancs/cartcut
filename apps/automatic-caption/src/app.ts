import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import "./automaticCaption";

@customElement("simple-app")
export class SimpleApp extends LitElement {
  createRenderRoot() {
    return this;
  }

  @property()
  timeline = {
    "db0d7134-4c82-4078-ae85-3b4dd13ece9b": {
      priority: 1,
      blob: "blob:file:///d9505c7e-51d3-4d61-97f3-0519c18264db",
      startTime: 0,
      duration: 52301.667,
      opacity: 100,
      location: { x: 0, y: 0 },
      trim: { startTime: 0, endTime: 52301.667 },
      rotation: 0,
      width: 1920,
      height: 1080,
      ratio: 1.7777777777777777,
      localpath: "/Users/huhhyeongjun/Downloads/test.MOV",
      isExistAudio: true,
      filetype: "video",
      codec: { video: "default", audio: "default" },
      speed: 1,
      filter: { enable: false, list: [] },
      origin: { width: 1920, height: 1080 },
      // `ax`/`ay` are lists of `[timeMs, value]` pairs. This fixture, like every
      // element factory in the main app, used to write `[[], []]` — two *empty*
      // pairs. Inlined rather than importing `emptyAnimation`, because this is a
      // separate Vite build with its own module graph.
      animation: {
        position: {
          isActivate: false,
          x: [],
          y: [],
          ax: [],
          ay: [],
        },
        opacity: { isActivate: false, x: [], ax: [] },
        scale: { isActivate: false, x: [], ax: [] },
        rotation: { isActivate: false, x: [], ax: [] },
      },
    },
    // A second clip, so the picker has an order to change and a waveform to
    // draw. Same file, so it is also the "two clips of one recording" case.
    "7f1e9c52-2d4b-4c8e-9a51-0c3f6b8d2e11": {
      priority: 2,
      startTime: 52301.667,
      duration: 12000,
      trim: { startTime: 0, endTime: 12000 },
      localpath: "/Users/huhhyeongjun/Downloads/test.MOV",
      filetype: "audio",
      speed: 1,
    },
  };

  handleComplate(e) {
    console.log(e.detail);
  }

  render() {
    return html` <automatic-caption
      .timeline=${this.timeline}
      .isDev=${true}
      @editComplate=${this.handleComplate}
    ></automatic-caption>`;
  }
}
