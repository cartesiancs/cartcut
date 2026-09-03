/**
 * The viewfinder: what the person being recorded sees.
 *
 * It shows the camera bubble where the finished file will put it, and nothing
 * else. That correspondence is the point — the layout comes from the same
 * `bubbleLayout.ts` the compositor uses, so somebody who moves the bubble to
 * the other corner sees the change here and gets it in the file, without the
 * preview ever being *of* the recording.
 *
 * The window it lives in is transparent, click-through and, critically,
 * `setContentProtection(true)` — so the compositor leaves it out of every
 * screen capture including ours. Without that the bubble would be captured into
 * the screen recording and the composite pass would draw a second one on top.
 * See `electron/lib/window.ts#createRecordOverlayWindow`.
 *
 * This is its own camera stream rather than a share of the engine's. Two
 * `getUserMedia` calls on one camera is one capture as far as the OS is
 * concerned, and passing a `MediaStream` between renderer processes is not
 * something the platform offers.
 */

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { bubbleRect } from "@app/features/record/bubbleLayout";
import {
  DEFAULT_RECORD_SETTINGS,
  type BubbleCorner,
  type BubbleShape,
  type BubbleSize,
} from "@app/features/record/recordSettings";

type OverlayState = {
  drawing: boolean;
  recording: boolean;
  cameraDeviceId: string;
  bubbleSize: BubbleSize;
  bubbleCorner: BubbleCorner;
  bubbleShape: BubbleShape;
};

const INITIAL: OverlayState = {
  drawing: false,
  recording: false,
  cameraDeviceId: "",
  bubbleSize: DEFAULT_RECORD_SETTINGS.bubbleSize,
  bubbleCorner: DEFAULT_RECORD_SETTINGS.bubbleCorner,
  bubbleShape: DEFAULT_RECORD_SETTINGS.bubbleShape,
};

@customElement("record-overlay")
export class RecordOverlay extends LitElement {
  @state() private overlay: OverlayState = INITIAL;

  /** The camera this element currently has open, so a re-render is not a re-open. */
  private openedDeviceId = "";
  private stream: MediaStream | null = null;

  static styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      pointer-events: none;
    }

    .bubble {
      position: absolute;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
      /*
       * A ring, matching the one the compositor strokes. It is the only part of
       * the preview that is decoration rather than correspondence — but a
       * transparent window with an unringed circle of video in it reads as a
       * hole in the screen rather than as a camera.
       */
      border: 2px solid rgba(255, 255, 255, 0.85);
      box-sizing: border-box;
      transition:
        top 120ms ease,
        left 120ms ease,
        width 120ms ease,
        height 120ms ease;
    }

    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      /* Mirrored, matching composeWithBubble in the engine. The two have to
         agree or the take is spent looking at the wrong side of a face. */
      transform: scaleX(-1);
      display: block;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();

    const api = (window as any).electronAPI;
    api?.res?.overlayRecord?.overlay(
      (_event: unknown, next: Partial<OverlayState>) => {
        this.overlay = { ...this.overlay, ...next };
      },
    );
  }

  disconnectedCallback(): void {
    this.releaseCamera();
    super.disconnectedCallback();
  }

  private releaseCamera(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.openedDeviceId = "";
  }

  /**
   * Open the selected camera, or close the one that is open.
   *
   * Guarded on the device id rather than run from `updated()` unconditionally:
   * Lit re-renders on every state change, and re-opening a camera on each one
   * would flash the bubble black every time the user moved it a corner over.
   */
  private async syncCamera(): Promise<void> {
    const wanted = this.overlay.cameraDeviceId;

    if (wanted === this.openedDeviceId) {
      return;
    }

    this.releaseCamera();

    if (wanted === "") {
      this.requestUpdate();
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: wanted } },
      });
      this.openedDeviceId = wanted;
    } catch (error) {
      console.warn("[record] overlay could not open the camera", error);
      this.openedDeviceId = "";
    }

    this.requestUpdate();
    await this.updateComplete;
    this.attachStream();
  }

  private attachStream(): void {
    const video = this.shadowRoot?.querySelector("video");
    if (video != null && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      void video.play().catch(() => {
        // Muted and inline, so autoplay is permitted; if a policy ever says
        // otherwise the bubble stays black rather than throwing.
      });
    }
  }

  updated(): void {
    void this.syncCamera();
    this.attachStream();
  }

  render() {
    if (this.stream == null) {
      return html``;
    }

    // The overlay covers one whole display, so its own viewport *is* the frame
    // the compositor works in — which is what lets the same layout function
    // answer for both, in two different pixel spaces.
    const frame = { width: window.innerWidth, height: window.innerHeight };
    const source = { width: 1280, height: 720 };
    const rect = bubbleRect(
      frame,
      source,
      this.overlay.bubbleSize,
      this.overlay.bubbleCorner,
      this.overlay.bubbleShape,
    );

    const radius =
      this.overlay.bubbleShape === "circle"
        ? "50%"
        : `${Math.round(Math.min(rect.width, rect.height) * 0.14)}px`;

    return html`
      <div
        class="bubble"
        style="left: ${rect.x}px; top: ${rect.y}px; width: ${rect.width}px;
               height: ${rect.height}px; border-radius: ${radius};"
      >
        <video autoplay muted playsinline></video>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "record-overlay": RecordOverlay;
  }
}
