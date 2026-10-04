/**
 * The panel section for a clip that carries an inline program.
 *
 * Shared by the effect, transition and graphic panels: what the program is
 * called, whether it draws and why not, and a way to keep it as a preset. An
 * agent sees the same diagnostics through `get_program`; a user sees them here,
 * which matters because an inline program that does not validate draws nothing
 * and would otherwise look like a bug in the clip.
 *
 * Light DOM and `display: block`, the two Lit rules CLAUDE.md states. Handlers
 * are arrow properties because the panels embed this inside their own
 * templates.
 */

import { LitElement, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import type { Diagnostic } from "../fx/inlineProgram";
import {
  presetIdProblem,
  programFilesFor,
  suggestedPresetId,
} from "../fx/programExport";
import { loadPresets } from "../fx/presetRegistry";
import { inlineDiagnostics } from "../fx/resolvePreset";
import { section } from "./optionKit";

function line(diagnostic: Diagnostic): string {
  const where =
    diagnostic.file == null
      ? ""
      : diagnostic.file + (diagnostic.line != null ? ":" + diagnostic.line : "") + " ";
  return where + diagnostic.message;
}

@customElement("option-program-section")
export class OptionProgramSection extends LitElement {
  @property({ attribute: false })
  elementId = "";

  /**
   * The program itself. Read from the store either way; passed in so that a
   * new program on the same clip is a property change and re-renders this.
   */
  @property({ attribute: false })
  program: unknown = null;

  @state()
  private presetId = "";

  @state()
  private status = "";

  /** The program the id field was last filled for, so a new clip gets a fresh suggestion. */
  private suggestedFor = "";

  createRenderRoot() {
    this.style.display = "block";
    return this;
  }

  private get element(): any {
    return useTimelineStore.getState().timeline[this.elementId] ?? null;
  }

  private handleInput = (event: Event) => {
    this.presetId = (event.target as HTMLInputElement).value.trim();
    this.status = "";
  };

  private handleSave = async () => {
    const element = this.element;
    if (element?.program == null) {
      return;
    }
    let files;
    try {
      files = programFilesFor(element, this.presetId);
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
      return;
    }
    const bridge = (globalThis as any)?.electronAPI?.req?.preset;
    if (typeof bridge?.saveProgram !== "function") {
      this.status = "Saving presets needs the desktop app.";
      return;
    }
    this.status = "Saving...";
    try {
      const saved = await bridge.saveProgram(
        this.presetId,
        files.manifestJson,
        files.sources,
        files.assets,
      );
      await loadPresets();
      this.status = "Saved as " + saved.id + ".";
    } catch (error) {
      this.status = error instanceof Error ? error.message : String(error);
    }
  };

  render() {
    const element = this.element;
    const program = element?.program;
    if (program == null) {
      return html``;
    }
    if (this.suggestedFor !== program.hash) {
      this.suggestedFor = program.hash;
      this.presetId = suggestedPresetId(program);
      this.status = "";
    }

    const { errors, warnings } = inlineDiagnostics(element);
    const idProblem = this.presetId === "" ? null : presetIdProblem(this.presetId);

    return section({
      title: "Inline program",
      body: html`
        <div class="opt-hint" style="margin-bottom: 8px;">
          <span class="material-symbols-outlined opt-hint-icon">code</span>
          ${program.manifest?.name ?? "Untitled"}, written for this clip
          (${program.manifest?.render?.type ?? "unknown"}).
        </div>
        ${errors.length > 0
          ? html`<div class="opt-hint" style="margin-bottom: 8px;">
              <span class="material-symbols-outlined opt-hint-icon">error</span>
              <div>
                Does not draw:
                ${errors.map((e) => html`<div>${line(e)}</div>`)}
              </div>
            </div>`
          : ""}
        ${warnings.length > 0
          ? html`<div class="opt-hint" style="margin-bottom: 8px;">
              <span class="material-symbols-outlined opt-hint-icon">info</span>
              <div>${warnings.map((w) => html`<div>${line(w)}</div>`)}</div>
            </div>`
          : ""}
        <div class="opt-field">
          <div class="opt-row">
            <input
              type="text"
              class="opt-text-input"
              aria-label="preset id"
              .value=${this.presetId}
              @input=${this.handleInput}
            />
            <button
              type="button"
              class="opt-text-btn"
              ?disabled=${errors.length > 0 || this.presetId === "" || idProblem != null}
              @click=${this.handleSave}
            >
              Save as preset
            </button>
          </div>
          ${idProblem != null || this.status !== ""
            ? html`<div class="opt-hint" style="margin-top: 6px;">
                ${idProblem ?? this.status}
              </div>`
            : ""}
        </div>
      `,
    });
  }
}
