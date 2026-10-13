/**
 * The timeline tabs: main, then each template opened from it.
 *
 * In the row above the timeline, beside the play controls and the timecode,
 * so the tabs sit with the thing they switch (`ui/timeline/Timeline.ts`). The
 * phone layout hides that row, and with it the tabs.
 *
 * The chips are `<preview-top-bar>`'s and `<app-window>`'s, `.tb-tab` in
 * `_toolbar.scss`, in a `.tb-tab-strip` that scrolls and fades the same way,
 * so the three tab rows in the app cannot drift apart. Main is always first
 * and has no close, as the preview tab has none: it is where closing any
 * other tab falls back to.
 *
 * What it shows is derived (`timelineWorkspace.ts#visibleTimelineTabs`), so a
 * template whose last clip was deleted loses its tab, and gets it back on an
 * undo, without any edit knowing tabs exist. Everything it does goes through
 * `navigation.ts`.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { visibleTimelineTabs } from "../../states/timelineWorkspace";
import {
  scrollTabIntoView,
  tabStripOverflow,
  wheelTabStrip,
} from "../window/tabStrip";
import { requestCloseTimelineTab, requestTimelineSwitch } from "./navigation";
import { MAIN_TIMELINE } from "./project";
import { saveCompositionAsTemplate } from "./saveAsTemplate";

type Tab = { id: string; label: string };

/** What the strip draws, compared to decide whether a store write concerns it. */
function tabsOf(): { active: string; tabs: Tab[] } {
  const state = useTimelineStore.getState();
  return {
    active: state.activeTimelineId,
    tabs: visibleTimelineTabs(state).map((id) => ({
      id,
      label:
        id === MAIN_TIMELINE ? "Main" : (state.compositions[id]?.name ?? "Template"),
    })),
  };
}

function sameTabs(a: Tab[], b: Tab[]): boolean {
  return (
    a.length === b.length &&
    a.every((tab, i) => tab.id === b[i].id && tab.label === b[i].label)
  );
}

function attr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toast(message: string) {
  (document.querySelector("toast-box") as { showToast?: (o: object) => void } | null)
    ?.showToast?.({ message, delay: "4000" });
}

@customElement("timeline-tabs")
export class TimelineTabs extends LitElement {
  @state() private active = MAIN_TIMELINE;
  @state() private tabs: Tab[] = [];
  @state() private fadeStart = false;
  @state() private fadeEnd = false;

  private unsubscribe: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrolledFor: string | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.pull();
    // Every store write reaches here, the playhead's included, so it compares
    // before it asks Lit for anything.
    this.unsubscribe = useTimelineStore.subscribe(() => this.pull());
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
  }

  private pull() {
    const next = tabsOf();
    if (next.active !== this.active) {
      this.active = next.active;
    }
    if (!sameTabs(next.tabs, this.tabs)) {
      this.tabs = next.tabs;
    }
  }

  private get scroller(): HTMLElement | null {
    return this.querySelector(".tb-tab-strip");
  }

  protected updated(): void {
    const scroller = this.scroller;
    if (scroller == null) {
      return;
    }
    if (this.resizeObserver == null) {
      this.resizeObserver = new ResizeObserver(() => this.syncFades());
      this.resizeObserver.observe(scroller);
    }
    this.syncFades();
    if (this.scrolledFor !== this.active) {
      this.scrolledFor = this.active;
      const tab = scroller.querySelector(
        `[data-timeline="${CSS.escape(this.active)}"]`,
      ) as HTMLElement | null;
      if (tab != null) {
        scrollTabIntoView(scroller, tab);
      }
    }
  }

  private syncFades() {
    const scroller = this.scroller;
    if (scroller == null) {
      return;
    }
    const { start, end } = tabStripOverflow(scroller);
    this.fadeStart = start;
    this.fadeEnd = end;
  }

  /** From the tab's context menu. */
  async saveTemplate(timelineId: string) {
    const outcome = await saveCompositionAsTemplate(timelineId);
    if (outcome.ok) {
      toast(
        outcome.warnings.length > 0
          ? `${outcome.name} saved to your templates. ${outcome.warnings.join(" ")}`
          : `${outcome.name} saved to your templates.`,
      );
      return;
    }
    if ("cancelled" in outcome) {
      return;
    }
    toast(outcome.message);
  }

  /** From the tab's context menu. */
  closeTab(timelineId: string) {
    requestCloseTimelineTab(timelineId);
  }

  private onContextMenu(event: MouseEvent, tab: Tab) {
    event.preventDefault();
    if (tab.id === MAIN_TIMELINE) {
      return;
    }
    const menu = document.querySelector("#menuRightClick");
    if (menu == null) {
      return;
    }
    const id = attr(tab.id);
    menu.innerHTML = `
        <menu-dropdown-body top="${event.clientY}" left="${event.clientX}">
          <menu-dropdown-item onclick="document.querySelector('timeline-tabs').saveTemplate('${id}')" item-name="Save as Template…" item-icon="bookmark_add"> </menu-dropdown-item>
          <menu-dropdown-item onclick="document.querySelector('timeline-tabs').closeTab('${id}')" item-name="Close" item-icon="close"> </menu-dropdown-item>
        </menu-dropdown-body>`;
  }

  private renderTab(tab: Tab) {
    const on = tab.id === this.active;
    return html`<button
      type="button"
      data-timeline=${tab.id}
      class="tb-tab ${on ? "is-on" : ""}"
      aria-selected=${on ? "true" : "false"}
      title=${tab.label}
      @click=${() => requestTimelineSwitch(tab.id)}
      @contextmenu=${(event: MouseEvent) => this.onContextMenu(event, tab)}
    >
      ${tab.label}
      ${tab.id === MAIN_TIMELINE
        ? ""
        : html`<span
            class="material-symbols-outlined tb-tab-close"
            role="button"
            title="Close ${tab.label}"
            aria-label="Close ${tab.label}"
            @click=${(event: Event) => {
              // Inside the tab button: without this the click would also
              // switch to the tab being closed.
              event.stopPropagation();
              requestCloseTimelineTab(tab.id);
            }}
            >close</span
          >`}
    </button>`;
  }

  render() {
    return html`<div
      class="tb-tab-strip ${this.fadeStart ? "fade-start" : ""} ${this.fadeEnd
        ? "fade-end"
        : ""}"
      role="tablist"
      aria-label="Timelines"
      @scroll=${() => this.syncFades()}
      @wheel=${wheelTabStrip}
    >
      ${this.tabs.map((tab) => this.renderTab(tab))}
    </div>`;
  }
}
