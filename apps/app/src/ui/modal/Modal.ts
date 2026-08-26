import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import {
  shortcutLabelWithAlternates,
  shortcutsByGroup,
} from "../../features/editor/shortcuts";

@customElement("modal-list-ui")
export class ModalList extends LitElement {
  private lc = new LocaleController(this);

  /**
   * The `#shortKey` help table.
   *
   * Rendered from `features/editor/shortcuts` rather than written out here.
   * The hardcoded version this replaces said "Control C" to Mac users, was
   * missing undo, redo, Escape and the preview zoom bindings, and had gone
   * stale in the way any second copy of a list eventually does.
   */
  private shortcutTable() {
    return html`
      <table class="table table-dark">
        ${shortcutsByGroup().map(
          ({ title, items }) => html`
            <tbody>
              <tr>
                <td colspan="2" class="text-white font-weight-lg">${title}</td>
              </tr>
              ${items.map(
                (spec) => html`
                  <tr>
                    <th scope="row">
                      ${shortcutLabelWithAlternates(spec.id)}
                    </th>
                    <td class="text-secondary">${spec.description}</td>
                  </tr>
                `,
              )}
            </tbody>
          `,
        )}
      </table>
    `;
  }

  createRenderRoot() {
    return this;
  }

  openRenderedVideoFolder() {
    const projectFolder = document.querySelector("#projectFolder").value;
    window.electronAPI.req.filesystem.openDirectory(projectFolder);
  }

  forceClose() {
    //ipcRenderer.send('FORCE_CLOSE')
    window.electronAPI.req.app.forceClose();
  }

  _handleClickChangeLang(lang) {
    this.lc.changeLanguage(lang);
    const needsToRestartModal = new bootstrap.Modal("#NeedsToRestart", {
      keyboard: false,
    });
    needsToRestartModal.show();
  }

  _handleClickRestart() {
    window.electronAPI.req.app.restart();
  }

  /**
   * Dismissing the progress dialog used to hide it and leave the frame loop
   * running to completion. It now stops the export as well.
   */
  _handleClickCancelRender() {
    const control = document.querySelector(
      "control-ui-render",
    ) as (HTMLElement & { cancelExport?: () => void }) | null;
    control?.cancelExport?.();
  }

  render() {
    return html`
      <dds-modal
        modal-id="exportVideoModal"
        modal-title="영상 내보내기"
        modal-subtitle=""
      >
        <dds-content>
          <div class="mb-3">
            <video id="exportVideo" controls?="controls"></video>
          </div>
        </dds-content>
        <dds-modal-button
          button-color="btn-blue"
          button-text-color="text-primary"
          is-dismiss="false"
          >저장</dds-modal-button
        >
        <dds-modal-button
          button-color="btn-light"
          button-text-color="text-dark"
          is-dismiss="true"
          >취소</dds-modal-button
        >
      </dds-modal>

      <dds-modal modal-id="progressRender" modal-title="Rendering...">
        <dds-content>
          <div class="mb-3">
            <div class="progress">
              <div
                id="progress"
                class="progress-bar"
                role="progressbar"
                style="width: 25%;"
                aria-valuenow="25"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                25%
              </div>
            </div>
            <b class="text-secondary"
              ><i class="fas fa-info-circle"></i>
              <span id="remainingTime">-s left</span>
            </b>

            <!-- <b class="text-secondary"
              ><i class="fas fa-info-circle"></i> 랜더링 100%에 도달해도
              일정시간 지연될 수 있어요.
            </b> -->
          </div>
        </dds-content>
        <dds-modal-button
          button-color="btn-light"
          button-text-color="text-dark"
          is-dismiss="true"
          @click=${this._handleClickCancelRender}
          >Cancel</dds-modal-button
        >
      </dds-modal>

      <dds-modal modal-id="downloadFfmpeg" modal-title="FFMPEG 다운로드중">
        <dds-content>
          <div class="mb-3">
            <div class="progress">
              <div
                id="download_progress_ffmpeg"
                class="progress-bar"
                role="progressbar"
                style="width: 25%;"
                aria-valuenow="25"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                25%
              </div>
            </div>
          </div>
        </dds-content>
        <dds-modal-button
          button-color="btn-light"
          button-text-color="text-dark"
          is-dismiss="true"
          >Close</dds-modal-button
        >
      </dds-modal>

      <dds-modal modal-id="progressFinish" modal-title="Rendering is complete">
        <dds-content>
          <div class="mb-3"></div>
        </dds-content>
        <dds-modal-button
          button-color="btn-blue-fill"
          is-dismiss="false"
          @click=${this.openRenderedVideoFolder}
          >Open Saved Folder</dds-modal-button
        >
        <dds-modal-button
          button-color="btn-light"
          button-text-color="text-dark"
          is-dismiss="true"
          >Close</dds-modal-button
        >
      </dds-modal>

      <dds-modal
        modal-id="progressError"
        modal-title="랜더링중 문제가 발생했어요"
      >
        <dds-content>
          <div class="mb-3">
            <p id="progressErrorMsg" class="text-secondary"></p>
          </div>
        </dds-content>
        <dds-modal-button
          button-color="btn-light"
          button-text-color="text-dark"
          is-dismiss="true"
          >닫기</dds-modal-button
        >
      </dds-modal>

      <dds-modal
        modal-id="whenClose"
        modal-title="Are you sure you want to exit the program?"
        modal-subtitle="Changes will not be saved."
      >
        <dds-content>
          <div class="mb-3"></div>
        </dds-content>
        <dds-modal-button
          button-color="btn-red-fill"
          is-dismiss="false"
          @click=${this.forceClose}
          >Yes, I'll exit.</dds-modal-button
        >
        <dds-modal-button
          button-color="btn-light"
          button-text-color="text-dark"
          is-dismiss="true"
          >No</dds-modal-button
        >
      </dds-modal>

      <dds-modal
        modal-id="whenTimelineChanged"
        modal-title="There are unsaved changes."
      >
        <dds-content>
          <div class="mb-3">
            <p id="whenTimelineChangedMsg" class="text-secondary"></p>
          </div>
        </dds-content>
        <dds-modal-button
          button-color="btn-light"
          button-text-color="text-dark"
          is-dismiss="true"
          >Close</dds-modal-button
        >
      </dds-modal>

      <div
        class="modal fade"
        id="shortKey"
        data-bs-keyboard="false"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">Shortcut</h5>
              <div class="mb-3">${this.shortcutTable()}</div>
            </div>
          </div>
        </div>
      </div>

      <div
        class="modal fade"
        id="changeLang"
        data-bs-keyboard="false"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">
                ${this.lc.t("modal.change_language")}
              </h5>

              <b class="text-secondary"
                ><i class="fas fa-info-circle"></i> ${this.lc.t(
                  "modal.change_language_description",
                )}
              </b>
              <div class="mt-3">
                <div class="flex row mb-3">
                  <button
                    class="btn btn-sm btn-default text-light mt-1"
                    @click=${() => this._handleClickChangeLang("en")}
                  >
                    English
                  </button>

                  <button
                    class="btn btn-sm btn-default text-light mt-1"
                    @click=${() => this._handleClickChangeLang("ko")}
                  >
                    한국어
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        class="modal fade"
        id="NeedsToRestart"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">
                ${this.lc.t("modal.needs_to_restart")}
              </h5>

              <b class="text-danger"
                ><i class="fas fa-info-circle"></i> ${this.lc.t(
                  "modal.needs_to_restart_description",
                )}
              </b>
              <div class="mt-3">
                <div class="flex row mb-3 gap-2">
                  <button
                    type="button"
                    class="col btn btn-secondary"
                    data-bs-dismiss="modal"
                  >
                    ${this.lc.t("modal.close")}
                  </button>
                  <button
                    type="button"
                    @click=${this._handleClickRestart}
                    class="col btn btn-danger"
                  >
                    ${this.lc.t("modal.restart")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
