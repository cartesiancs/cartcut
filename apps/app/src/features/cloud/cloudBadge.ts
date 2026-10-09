/**
 * The top-left corner of a cloud tile: a cloud until clicked, then the
 * download's ring in the same place.
 *
 * Its own element, subscribed to its own download and nothing else. Progress
 * arrives a percent at a time, and re-rendering four mounted grids of seventy
 * tiles for each one would cost a frame per percent.
 *
 * SVG with no `<title>` and no text, so the tile's text stays its name alone:
 * `tests/e2e/harness/ui.ts` finds a tile by matching the whole of it.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

import { ringDash } from "../export/exportRing";
import { cloudStore } from "./cloudStore";
import { cloudKey } from "./cloudTypes";

const RING_SIZE = 16;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;

/** Material Icons' `cloud`, on a 24 unit box. */
const CLOUD_PATH =
  "M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z";

@customElement("cloud-badge")
export class CloudBadge extends LitElement {
  @property({ type: String })
  kind = "";

  @property({ type: String, attribute: "item-id" })
  itemId = "";

  /** This item's download, 0 to 1, or `undefined` when none is running. */
  private fraction: number | undefined = undefined;
  private release: (() => void) | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.release = cloudStore.subscribe((state) => {
      const next = state.downloads[cloudKey(this.kind, this.itemId)];
      if (next !== this.fraction) {
        this.fraction = next;
        this.requestUpdate();
      }
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.release?.();
    this.release = null;
  }

  willUpdate() {
    // Lit reuses this element for another tile when a grid reorders, so the
    // download is read for whichever item it is showing now.
    this.fraction = cloudStore.getState().downloads[cloudKey(this.kind, this.itemId)];
  }

  render() {
    if (this.fraction == null) {
      return html`<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d=${CLOUD_PATH}></path>
      </svg>`;
    }

    // Before the first byte there is no number to show, so a quarter arc
    // turns until there is.
    const waiting = this.fraction <= 0;
    const { array, offset } = ringDash(this.fraction * 100, RING_RADIUS);
    const centre = RING_SIZE / 2;
    return html`<svg
      class="cloud-ring ${waiting ? "is-spinning" : ""}"
      width=${RING_SIZE}
      height=${RING_SIZE}
      viewBox="0 0 ${RING_SIZE} ${RING_SIZE}"
      aria-hidden="true"
    >
      <circle
        cx=${centre}
        cy=${centre}
        r=${RING_RADIUS}
        fill="none"
        stroke="rgba(255, 255, 255, 0.22)"
        stroke-width=${RING_STROKE}
      ></circle>
      <circle
        cx=${centre}
        cy=${centre}
        r=${RING_RADIUS}
        fill="none"
        stroke="#3d7eff"
        stroke-width=${RING_STROKE}
        stroke-linecap="round"
        stroke-dasharray=${waiting ? `${array * 0.25} ${array * 0.75}` : array}
        stroke-dashoffset=${waiting ? 0 : offset}
        transform="rotate(-90 ${centre} ${centre})"
      ></circle>
    </svg>`;
  }
}
