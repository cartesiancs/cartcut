import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import { chatLLMStore, IChatLLMPanelStore } from "../../states/chatLLM";
import { ToastController } from "../../controllers/toast";
import { actionParsor, parseCommands } from "./resultParser";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { assetStore } from "../../states/assetStore";
import { joinPath, readDirectory } from "../asset/directoryEntries";

@customElement("ai-input")
export class AiInput extends LitElement {
  isEnter: boolean;
  constructor() {
    super();
    this.isEnter = false;
  }

  toast = new ToastController(this);

  @property()
  uiState: IUIStore = uiStore.getInitialState();
  chatLLMState: IChatLLMPanelStore = chatLLMStore.getInitialState();
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  createRenderRoot() {
    // const parser = parseCommands(
    //   `ADD VIDEO "/folder/day.mp4" x=0:y=0:w=1920:h=1080:t=0:d=30 ADD TEXT "Daily Vlog" x=50:y=50:w=300:t=1:d=3 ADD TEXT "이건텍스트임" x=0:y=0:w=200:t=5:d=2 ADD TEXT "이건텍스트임" x=0:y=0:w=200:t=8:d=2`,
    // );

    // console.log(parser);

    // actionParsor(parser);

    if (getLocationEnv() != "electron") {
      this.classList.add("d-none");
    }

    return this;
  }

  handleEnter(event) {
    if (event.key === "Enter") {
      if (!this.isEnter) {
        this.isEnter = true;
        event.preventDefault();
        this.executeFunction(event.target.value);
        document.querySelector("#chatLLMInput").value = "";

        setTimeout(() => {
          this.isEnter = false;
        }, 100);
      }
    }
  }

  executeFunction(value) {
    console.log("Entered value:", value);
    const lists = this.mapTimeline();

    console.log(`${lists.join(" ")} \n ${value}`);

    const directory = assetStore.getState().nowDirectory;
    if (directory == "") {
      this.toast.show("Please specify a directory", 2000);
      return 0;
    }

    readDirectory(directory).then((entries) => {
      const resultList = entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => `EXIST "${joinPath(directory, entry.name)}"`);

      window.electronAPI.req.ai
        .text(
          "gpt-4o-mini",
          `${resultList.join("\n")} \n ${lists.join("\n")} \n ${value}`,
        )
        .then((result) => {
          if (result.status == 1) {
            this.uiState.setChatSidebar(250);

            this.chatLLMState.addList(result.text.content);

            const parser = parseCommands(result.text.content);

            actionParsor(parser);

            console.log(result.text.content);
          } else {
            document
              .querySelector("toast-box")
              .showToast({ message: "Invaild OpenAI Key", delay: "2000" });
          }
        });
    });
  }

  mapTimeline(): string[] {
    const list: any = [];
    const timeline = useTimelineStore.getState();
    for (const key in timeline.timeline) {
      if (Object.prototype.hasOwnProperty.call(timeline.timeline, key)) {
        const element = timeline.timeline[key];
        if (element.filetype == "text") {
          const options = [
            `x=${element.location?.x}`,
            `y=${element.location?.y}`,
            `w=${element.width}`,
            `h=${element.height}`,
            `t=${element.startTime}`,
            `d=${element.duration}`,
          ];
          list.push(`TEXT "${element.text}" ${options.join(":")}`);
        } else if (element.filetype == "image") {
          const options = [
            `x=${element.location?.x}`,
            `y=${element.location?.y}`,
            `w=${element.width}`,
            `h=${element.height}`,
            `t=${element.startTime}`,
            `d=${element.duration}`,
          ];
          list.push(`IMAGE "${key}" ${options.join(":")}`);
        } else if (element.filetype == "video") {
          const options = [
            `x=${element.location?.x}`,
            `y=${element.location?.y}`,
            `w=${element.width}`,
            `h=${element.height}`,
            `t=${element.startTime}`,
            `d=${element.duration}`,
          ];
          list.push(`VIDEO "${key}" ${options.join(":")}`);
        } else if (element.filetype == "audio") {
          const options = [`t=${element.startTime}`, `d=${element.duration}`];
          list.push(`AUDIO "${key}" ${options.join(":")}`);
        }
      }
    }

    return list;
  }

  handleClickInput() {
    this.timelineState.setCursorType("lockKeyboard");
  }

  panelOpen() {
    this.uiState.setChatSidebar(250);
  }

  render() {
    return html`
      <div class="input-group input-group-sm d-flex align-items-center gap-2">
        <input
          type="text"
          class="form-control bg-default text-light bg-darker"
          placeholder="Ask me anything..."
          value=""
          id="chatLLMInput"
          @keydown="${this.handleEnter}"
          @click=${this.handleClickInput}
        />
        <span
          @click=${this.panelOpen}
          class="material-symbols-outlined timeline-bottom-question-icon icon-sm  text-secondary"
          >right_panel_open</span
        >
      </div>
    `;
  }
}
