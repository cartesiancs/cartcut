import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { selectionStore } from "../../states/selectionStore";
import { uiStore } from "../../states/uiStore";
import {
  addTrack,
  capabilities,
  clearSelection,
  pasteFromClipboard,
  redo,
  undo,
  type EditorCapabilities,
} from "../editor/actions";
import { BUTTONS, type ToolbarButton } from "../editor/timelineToolbar";
import { extensionSidebarTabs } from "../extension/views";
import { contributionStore } from "../extension/contributions";
import {
  TRACK_KINDS,
  TRACK_KIND_ICON,
  TRACK_KIND_LABEL,
} from "../timeline/trackKinds";
import { mobileStore, type MobileSheet } from "./mobileStore";
import { pickDeviceMedia } from "./deviceImport";
import { phoneTimecode } from "./phoneTimecode";

/**
 * The phone layout's own chrome: a top bar, a transport row under the preview,
 * a bottom toolbar, and the header of whichever sheet is open.
 *
 * Nothing here edits anything by itself. Every button reaches the same
 * function its desktop counterpart does (`editor/actions.ts`, the timeline's
 * own `play`/`stop`, Bootstrap's tab switch for the left column), so the phone
 * cannot drift from the desktop editor's rules. The columns themselves are the
 * desktop ones, moved by `_mobile.scss`.
 */

type TimelineUiLike = HTMLElement & {
  play?: () => void;
  stop?: () => void;
};

type PreviewLike = HTMLElement & { fitPreview?: () => void };

/** One of the left column's tabs, as a toolbar entry. */
type PanelTool = { pane: string; icon: string; label: string };

const PANEL_TOOLS: PanelTool[] = [
  { pane: "nav-draft", icon: "perm_media", label: "Media" },
  { pane: "nav-text", icon: "text_fields", label: "Text" },
  { pane: "nav-fx", icon: "auto_awesome", label: "Effects" },
  { pane: "nav-template", icon: "dashboard_customize", label: "Templates" },
  { pane: "nav-util", icon: "page_info", label: "Tools" },
  { pane: "nav-option", icon: "extension", label: "Extensions" },
  { pane: "nav-home", icon: "aspect_ratio", label: "Project" },
];

/** Undo and redo live on the transport row, as in every phone editor. */
const CLIP_BUTTONS: ToolbarButton[] = BUTTONS.filter(
  (spec) => spec.icon !== "undo" && spec.icon !== "redo",
);

/** Short labels for the clip toolbar, keyed by the desktop button's icon. */
const SHORT_LABEL: Record<string, string> = {
  call_split: "Split",
  call_merge: "Merge",
  content_cut: "Cut",
  content_copy: "Copy",
  content_paste: "Paste",
  rotate_90_degrees_cw: "Rotate",
  music_off: "Detach",
  crop_free: "Crop",
  delete: "Delete",
};

/**
 * Show one tab of the left column.
 *
 * Through Bootstrap's own `Tab`, against the desktop sidebar button that owns
 * the pane, so the active tab is one piece of state whichever layout set it.
 */
function showPane(pane: string): void {
  const button = document.querySelector(
    `#sidebar [data-bs-target="#${pane}"]`,
  );
  if (button != null && typeof bootstrap !== "undefined") {
    bootstrap.Tab.getOrCreateInstance(button).show();
  }
}

function syncSheetClasses(sheet: MobileSheet): void {
  // A sheet is a panel over the timeline, so a press inside one is not the
  // user clicking away from the selection. Without this the timeline's
  // document-level `mousedown` cleared it on the first tap in the inspector,
  // and the inspector, which has nothing to show without one, closed.
  if (sheet != null) {
    for (const id of ["split_col_1", "split_col_3"]) {
      document.getElementById(id)?.setAttribute("data-keeps-selection", "");
    }
  }
  const root = document.documentElement.classList;
  root.toggle("m-sheet-open", sheet != null);
  root.toggle("m-sheet-panel", sheet?.kind === "panel");
  root.toggle("m-sheet-option", sheet?.kind === "option");
}

mobileStore.subscribe((state) => syncSheetClasses(state.sheet));

@customElement("mobile-top-bar")
export class MobileTopBar extends LitElement {
  createRenderRoot() {
    return this;
  }

  private openProject = () => {
    showPane("nav-home");
    mobileStore.getState().open({
      kind: "panel",
      pane: "nav-home",
      title: "Project",
    });
  };

  render() {
    return html`<div class="m-top-bar">
      <button
        type="button"
        class="m-icon-btn"
        aria-label="Project settings"
        @click=${this.openProject}
      >
        <span class="material-symbols-outlined">tune</span>
      </button>
      <div class="m-brand">CartCut</div>
      <export-button></export-button>
    </div>`;
  }
}

@customElement("mobile-transport")
export class MobileTransport extends LitElement {
  @state() private cursor = useTimelineStore.getState().cursor;
  @state() private isPlay = useTimelineStore.getState().control.isPlay;
  @state() private fps = renderOptionStore.getState().options.fps;
  @state() private durationMs =
    renderOptionStore.getState().options.duration * 1000;
  @state() private caps: EditorCapabilities = capabilities();

  private unsubscribe: Array<() => void> = [];

  createRenderRoot() {
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe.push(
      useTimelineStore.subscribe((state) => {
        this.cursor = state.cursor;
        this.isPlay = state.control.isPlay;
        if (!state.control.isPlay) {
          this.caps = capabilities();
        }
      }),
      renderOptionStore.subscribe((state) => {
        this.fps = state.options.fps;
        this.durationMs = state.options.duration * 1000;
      }),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe.forEach((off) => off());
    this.unsubscribe = [];
  }

  private timeline(): TimelineUiLike | null {
    return document.querySelector("timeline-ui");
  }

  private togglePlay = () => {
    const timeline = this.timeline();
    if (this.isPlay) {
      timeline?.stop?.();
    } else {
      timeline?.play?.();
    }
  };

  private toStart = () => {
    const control: any = document.querySelector("element-control");
    control?.reset?.();
    useTimelineStore.getState().setPlay(false);
  };

  private fit = () => {
    (document.querySelector("preview-canvas") as PreviewLike | null)?.fitPreview?.();
  };

  render() {
    return html`<div class="m-transport">
      <div class="m-timecode">
        <span class="m-timecode-now"
          >${phoneTimecode(this.cursor, this.fps, true)}</span
        >
        <span class="m-timecode-total"
          >/ ${phoneTimecode(this.durationMs, this.fps, false)}</span
        >
      </div>
      <div class="m-transport-center">
        <button
          type="button"
          class="m-icon-btn"
          aria-label="Go to start"
          @click=${this.toStart}
        >
          <span class="material-symbols-outlined">skip_previous</span>
        </button>
        <button
          type="button"
          id="mobilePlayToggle"
          class="m-play-btn"
          aria-label=${this.isPlay ? "Stop" : "Play"}
          @click=${this.togglePlay}
        >
          <span class="material-symbols-outlined"
            >${this.isPlay ? "pause" : "play_arrow"}</span
          >
        </button>
      </div>
      <div class="m-transport-right">
        <button
          type="button"
          class="m-icon-btn"
          aria-label="Undo"
          ?disabled=${!this.caps.canUndo}
          @click=${undo}
        >
          <span class="material-symbols-outlined">undo</span>
        </button>
        <button
          type="button"
          class="m-icon-btn"
          aria-label="Redo"
          ?disabled=${!this.caps.canRedo}
          @click=${redo}
        >
          <span class="material-symbols-outlined">redo</span>
        </button>
        <button
          type="button"
          class="m-icon-btn"
          aria-label="Fit preview"
          @click=${this.fit}
        >
          <span class="material-symbols-outlined">fit_screen</span>
        </button>
      </div>
    </div>`;
  }
}

@customElement("mobile-toolbar")
export class MobileToolbar extends LitElement {
  @state() private caps: EditorCapabilities = capabilities();
  @state() private selection: string[] = selectionStore.getState().ids;
  @state() private sheet: MobileSheet = mobileStore.getState().sheet;
  @state() private trackMenu = false;

  private unsubscribe: Array<() => void> = [];

  createRenderRoot() {
    // Every clip tool acts on the selection, and the timeline clears it on
    // any press outside itself that does not carry this.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe.push(
      selectionStore.subscribe((state) => {
        this.selection = state.ids;
        this.caps = capabilities();
        // The inspector has nothing to show once nothing is selected.
        if (state.ids.length === 0 && mobileStore.getState().sheet?.kind === "option") {
          mobileStore.getState().close();
        }
      }),
      useTimelineStore.subscribe((state) => {
        // `canSplit` follows the playhead; frozen during playback for the
        // reason `timelineToolbar.ts` gives.
        if (!state.control.isPlay) {
          this.caps = capabilities();
        }
      }),
      mobileStore.subscribe((state) => {
        this.sheet = state.sheet;
      }),
      contributionStore.subscribe(() => this.requestUpdate()),
      uiStore.subscribe(() => this.requestUpdate()),
    );
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe.forEach((off) => off());
    this.unsubscribe = [];
  }

  private openPanel(tool: PanelTool) {
    this.trackMenu = false;
    const current = this.sheet;
    if (current?.kind === "panel" && current.pane === tool.pane) {
      mobileStore.getState().close();
      return;
    }
    showPane(tool.pane);
    mobileStore
      .getState()
      .open({ kind: "panel", pane: tool.pane, title: tool.label });
  }

  private openInspector = () => {
    this.trackMenu = false;
    mobileStore.getState().open({ kind: "option" });
  };

  private closeSheet = () => {
    mobileStore.getState().close();
  };

  private deselect = () => {
    this.trackMenu = false;
    clearSelection();
    // The canvas draws its selection from its own copy; a press on empty
    // timeline is what it listens to, so it is told directly as well.
    (document.querySelector("element-timeline-canvas") as any)?.drawCanvas?.();
  };

  private panelTools(): PanelTool[] {
    return [
      ...PANEL_TOOLS,
      ...extensionSidebarTabs().map((tab) => ({
        pane: tab.paneId,
        icon: tab.icon,
        label: tab.title,
      })),
    ];
  }

  private tool(
    icon: string,
    label: string,
    run: () => void,
    options: { enabled?: boolean; active?: boolean; danger?: boolean } = {},
  ) {
    const enabled = options.enabled ?? true;
    return html`<button
      type="button"
      class="m-tool ${options.active ? "is-active" : ""} ${options.danger
        ? "is-danger"
        : ""}"
      aria-label=${label}
      ?disabled=${!enabled}
      @click=${run}
    >
      <span class="material-symbols-outlined">${icon}</span>
      <span class="m-tool-label">${label}</span>
    </button>`;
  }

  private mainTools() {
    const sheet = this.sheet;
    // Import first: on a phone it is the only way in for the user's own
    // footage, and every phone editor opens its tool row with it.
    return html`${this.tool("add_photo_alternate", "Import", pickDeviceMedia)}
    ${this.panelTools().map((tool) =>
      this.tool(tool.icon, tool.label, () => this.openPanel(tool), {
        active: sheet?.kind === "panel" && sheet.pane === tool.pane,
      }),
    )}
    ${this.tool("add_box", "Track", () => (this.trackMenu = !this.trackMenu), {
      active: this.trackMenu,
    })}
    ${this.tool("content_paste", "Paste", pasteFromClipboard, {
      enabled: this.caps.canPaste,
    })}`;
  }

  private clipTools() {
    return html`${this.tool("tune", "Edit", this.openInspector, {
      active: this.sheet?.kind === "option",
    })}
    ${CLIP_BUTTONS.map((spec) =>
      this.tool(spec.icon, SHORT_LABEL[spec.icon] ?? spec.label, spec.run, {
        enabled: spec.enabled(this.caps),
        danger: spec.icon === "delete",
      }),
    )}`;
  }

  private renderTrackMenu() {
    if (!this.trackMenu) {
      return nothing;
    }
    return html`<div class="m-track-menu" role="menu">
      ${TRACK_KINDS.map(
        (kind) => html`<button
          type="button"
          role="menuitem"
          class="m-track-menu-item"
          @click=${() => {
            this.trackMenu = false;
            addTrack(kind);
          }}
        >
          <span class="material-symbols-outlined">${TRACK_KIND_ICON[kind]}</span>
          ${TRACK_KIND_LABEL[kind]} track
        </button>`,
      )}
    </div>`;
  }

  private renderSheetHeader() {
    const sheet = this.sheet;
    if (sheet == null) {
      return nothing;
    }
    const title = sheet.kind === "panel" ? sheet.title : "Edit clip";
    const isMedia = sheet.kind === "panel" && sheet.pane === "nav-draft";
    return html`<div class="m-sheet-header">
      <span class="m-sheet-grabber"></span>
      <span class="m-sheet-title">${title}</span>
      ${isMedia
        ? html`<button
            type="button"
            class="m-sheet-action"
            @click=${pickDeviceMedia}
          >
            <span class="material-symbols-outlined">add_photo_alternate</span>
            Import from device
          </button>`
        : nothing}
      <button
        type="button"
        class="m-icon-btn"
        aria-label="Close panel"
        @click=${this.closeSheet}
      >
        <span class="material-symbols-outlined">check</span>
      </button>
    </div>`;
  }

  render() {
    const hasSelection = this.selection.length > 0;
    return html`${this.renderSheetHeader()} ${this.renderTrackMenu()}
      <div class="m-toolbar ${hasSelection ? "is-clip" : ""}">
        ${hasSelection
          ? html`<button
              type="button"
              class="m-toolbar-back"
              aria-label="Done editing clip"
              @click=${this.deselect}
            >
              <span class="material-symbols-outlined">chevron_left</span>
            </button>`
          : nothing}
        <div class="m-toolbar-scroll">
          ${hasSelection ? this.clipTools() : this.mainTools()}
        </div>
      </div>`;
  }
}
