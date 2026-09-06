/**
 * The Proxy Media panel.
 *
 * Two controls and a list. The mode switch is instant and free; generation is
 * slow and shows what it is doing, because a 3600x2338 120fps source takes
 * roughly a minute to transcode and a progress bar is the difference between
 * "working" and "hung".
 *
 * It lists the *distinct sources* on the timeline, never the clips: twelve
 * clips cut from four files need four transcodes, and a list of twelve rows —
 * seven of them the same filename — would invite the user to think otherwise.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import {
  proxyStore,
  type ProxyEntry,
  type ProxyMode,
  type ProxyProgress,
} from "../../states/proxyStore";
import { refreshProxies } from "./proxyBridge";
import { toLocalPathKey, toOsPath } from "./proxyPath";

type Row = {
  source: string;
  name: string;
  clips: number;
  entry: ProxyEntry | undefined;
  /** Undefined until inspected; true when the source is heavy enough to matter. */
  wanted: boolean | undefined;
};

@customElement("proxy-panel")
export class ProxyPanel extends LitElement {
  @state() private mode: ProxyMode = proxyStore.getState().mode;
  @state() private bySource: Record<string, ProxyEntry> =
    proxyStore.getState().bySource;
  @state() private progress: ProxyProgress | null = null;
  @state() private busy = false;
  @state() private message = "";
  @state() private wanted: Record<string, boolean> = {};

  private disposers: (() => void)[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.disposers.push(
      proxyStore.subscribe((s) => {
        this.mode = s.mode;
        this.bySource = s.bySource;
        this.progress = s.progress;
      }),
      // The panel lists sources, so it has to notice a clip being added or a
      // file being replaced. Cheap: `sources()` is one pass over the elements.
      useTimelineStore.subscribe(() => this.requestUpdate()),
    );
    void refreshProxies();
  }

  disconnectedCallback(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    super.disconnectedCallback();
  }

  /** Distinct video sources on the timeline, with how many clips use each. */
  private rows(): Row[] {
    const counts = new Map<string, number>();
    for (const element of Object.values(
      useTimelineStore.getState().timeline,
    ) as { filetype: string; localpath: string }[]) {
      if (element.filetype !== "video") continue;
      counts.set(element.localpath, (counts.get(element.localpath) ?? 0) + 1);
    }

    return [...counts.entries()]
      .map(([source, clips]) => ({
        source,
        name: fileName(source),
        clips,
        entry: this.bySource[source],
        wanted: this.wanted[source],
      }))
      .sort((a, b) => b.clips - a.clips || a.name.localeCompare(b.name));
  }

  private async inspect() {
    const sources = this.rows().map((r) => toOsPath(r.source));
    const results = await window.electronAPI.req.proxy.inspect(sources);
    const next: Record<string, boolean> = {};
    for (const r of results) {
      next[toLocalPathKey(r.source)] = r.needsProxy;
    }
    this.wanted = next;
    const n = Object.values(next).filter(Boolean).length;
    this.message =
      n === 0
        ? "Nothing here is heavy enough to need a proxy."
        : `${n} of ${sources.length} would benefit.`;
  }

  private async generate(force: boolean) {
    if (this.busy) return;
    this.busy = true;
    this.message = "";
    try {
      const sources = this.rows().map((r) => toOsPath(r.source));
      const result = await window.electronAPI.req.proxy.generate(
        sources,
        force,
      );
      await refreshProxies();
      const parts: string[] = [];
      if (result.made.length) parts.push(`${result.made.length} ready`);
      if (result.skipped.length)
        parts.push(`${result.skipped.length} not needed`);
      if (result.failed.length) parts.push(`${result.failed.length} failed`);
      this.message = parts.join(", ") || "Nothing to do.";
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      proxyStore.getState().setProgress(null);
    }
  }

  private async clear() {
    await window.electronAPI.req.proxy.clear();
    await refreshProxies();
    this.message = "Proxies deleted.";
  }

  render() {
    const rows = this.rows();
    const have = rows.filter((r) => r.entry != null).length;

    return html`
      <div class="p-4 w-100 h-100 overflow-auto" style="max-width: 46rem;">
        <h5 class="text-light">Proxy Media</h5>
        <p class="text-secondary" style="font-size: 0.8rem;">
          Small stand-ins the preview plays instead of your originals. Exports
          always use the originals, so this only affects what you see while
          editing.
        </p>

        <div class="d-flex align-items-center gap-2 mb-3">
          <button
            class="btn btn-sm ${this.mode === "prefer"
              ? "btn-primary"
              : "btn-secondary"}"
            @click=${() => proxyStore.getState().setMode("prefer")}
          >
            Use proxies
          </button>
          <button
            class="btn btn-sm ${this.mode === "off"
              ? "btn-primary"
              : "btn-secondary"}"
            @click=${() => proxyStore.getState().setMode("off")}
          >
            Originals
          </button>
          <span class="text-secondary ms-2" style="font-size: 0.8rem;">
            ${have} of ${rows.length} sources have a proxy
          </span>
        </div>

        <div class="d-flex align-items-center gap-2 mb-3">
          <button
            class="btn btn-sm btn-primary"
            ?disabled=${this.busy || rows.length === 0}
            @click=${() => this.generate(false)}
          >
            ${this.busy ? "Generating…" : "Generate for heavy sources"}
          </button>
          <button
            class="btn btn-sm btn-secondary"
            ?disabled=${this.busy || rows.length === 0}
            @click=${() => this.generate(true)}
          >
            Generate for all
          </button>
          <button
            class="btn btn-sm btn-secondary"
            ?disabled=${this.busy || rows.length === 0}
            @click=${() => this.inspect()}
          >
            Check
          </button>
          <button
            class="btn btn-sm btn-secondary"
            ?disabled=${this.busy}
            @click=${() => this.clear()}
          >
            Delete all
          </button>
        </div>

        ${this.progress
          ? html`<div class="mb-3">
              <div class="text-secondary" style="font-size: 0.75rem;">
                ${fileName(this.progress.source)} —
                ${this.progress.index + 1} of ${this.progress.total}
              </div>
              <div class="progress" style="height: 4px;">
                <div
                  class="progress-bar"
                  style="width: ${Math.round(
                    (this.progress.fraction ?? 0) * 100,
                  )}%"
                ></div>
              </div>
            </div>`
          : ""}
        ${this.message
          ? html`<p class="text-secondary" style="font-size: 0.8rem;">
              ${this.message}
            </p>`
          : ""}

        <table class="table table-sm table-dark" style="font-size: 0.8rem;">
          <thead>
            <tr>
              <th>Source</th>
              <th class="text-end">Clips</th>
              <th class="text-end">Proxy</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(
              (r) => html`<tr>
                <td class="text-truncate" style="max-width: 24rem;">
                  ${r.name}
                </td>
                <td class="text-end">${r.clips}</td>
                <td class="text-end">
                  ${r.entry
                    ? html`<span class="text-success"
                        >${r.entry.width}x${r.entry.height}</span
                      >`
                    : r.wanted === false
                      ? html`<span class="text-secondary">not needed</span>`
                      : html`<span class="text-secondary">—</span>`}
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
        ${rows.length === 0
          ? html`<p class="text-secondary" style="font-size: 0.8rem;">
              No video clips on the timeline yet.
            </p>`
          : ""}
      </div>
    `;
  }
}

/** The last path segment, for display. */
function fileName(p: string): string {
  const parts = p.split(/[\\/]/);
  return decodeURIComponent(parts[parts.length - 1] || p);
}

