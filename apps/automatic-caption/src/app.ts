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
