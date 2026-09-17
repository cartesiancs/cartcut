/**
 * The clip picker: which clips to caption, and in what order.
 *
 * A dark overlay of its own rather than a Bootstrap modal. The vendored
 * Bootstrap is 5.0.2, which has no `data-bs-theme`, and `devent-designsystem.css`
 * styles `.modal-content` light, so the dialog this replaced came up white over
 * a dark editor. It was also a table of file names, which tells two takes of
 * the same shot apart about as well as their names do.
 *
 * Every decision lives in `features/caption/`: the ordered selection in
 * `clipPick.ts`, the tray's drag and the keyboard in `clipTray.ts`, and what a
 * tile shows in `clipTile.ts`. This file measures, paints and dispatches. The
 * selection itself belongs to the panel: this element reports a new one with
 * `clipPickChange` and draws whatever `pick` it is handed.
 *
 * No backticks in the style block below: it sits inside an html template
 * literal, and one would end it. And no header or footer elements:
 * devent-designsystem.css gives every header a 30px top margin.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import {
  allPicked,
  movePick,
  nudgePick,
  pickAll,
  pickedSources,
  removePick,
  togglePick,
  type ClipPick,
} from "../../app/src/features/caption/clipPick";
import {
  TRAY_IDLE,
  pickerKeyIntent,
  reduceTrayDrag,
  trayShift,
  type PickerZone,
  type TrayDrag,
} from "../../app/src/features/caption/clipTray";
import {
  clipTiles,
  posterMs,
  skimMs,
  thumbRequest,
  tileWave,
  type ClipTile,
} from "../../app/src/features/caption/clipTile";
import type { CaptionSource } from "../../app/src/features/caption/sources";
import {
  createVideoTileProvider,
  type VideoTileProvider,
} from "../../app/src/features/timeline/strip/videoTiles";
import {
  sharedAudioPeakProvider,
  type AudioPeakProvider,
} from "../../app/src/features/timeline/strip/audioPeaks";
import { IS_MAC } from "../../app/src/utils/platform";

/**
 * One decode height for the grid and the tray alike, in device pixels, so a
 * chip reuses the frame its tile already decoded.
 */
const THUMB_H = 180;

@customElement("caption-clip-picker")
export class CaptionClipPicker extends LitElement {
  /** Every transcribable clip, in timeline order. */
  @property({ attribute: false })
  rows: CaptionSource[] = [];

  /** The chosen keys, in the chosen order. Owned by the panel. */
  @property({ attribute: false })
  pick: ClipPick = [];

  @property({ type: Boolean })
  open = false;

  private _tiles: VideoTileProvider | null = null;
  private _peaks: AudioPeakProvider | null = null;
  private _releases: Array<() => void> = [];
  private _drag: TrayDrag = TRAY_IDLE;
  private _dragPitch = 0;
  private _focusAfterRender: { zone: "tile" | "chip"; key: string } | null =
    null;
  private _returnFocus: HTMLElement | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // No box of its own: the scrim is fixed and covers the viewport.
    this.style.display = "contents";
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._release();
  }

  protected updated(changed: PropertyValues<this>) {
    if (changed.has("open")) {
      if (this.open) {
        this._acquire();
      } else if (changed.get("open") === true) {
        this._release();
      }
    }
    if (!this.open) {
      return;
    }

    this._paintAll();

    const target = this._focusAfterRender;
    if (target != null) {
      this._focusAfterRender = null;
      this._focusKey(target.zone, target.key);
    }
  }

  // ------------------------------------------------------------ lifecycle

  private _acquire() {
    this._returnFocus = document.activeElement as HTMLElement | null;
    // Captured on window so it runs ahead of the editor's own shortcuts, which
    // listen in the bubble phase. Backspace there deletes the selected clip,
    // and that is the clip being chosen here.
    window.addEventListener("keydown", this._onKeydown, true);

    this._tiles = createVideoTileProvider();
    this._peaks = sharedAudioPeakProvider();
    this._releases = [
      this._tiles.onReady(() => this._paintAll()),
      this._peaks.onReady(() => this._paintAll()),
    ];

    const first = this.pick[0] ?? this.rows[0]?.key;
    if (first != null) {
      this._focusAfterRender = { zone: "tile", key: first };
    }
  }

  private _release() {
    window.removeEventListener("keydown", this._onKeydown, true);
    for (const release of this._releases) {
      release();
    }
    this._releases = [];
    // The frame cache is this picker's own. The peak cache is shared with the
    // timeline and is left alone.
    this._tiles?.dispose();
    this._tiles = null;
    this._peaks = null;
    this._drag = TRAY_IDLE;

    const back = this._returnFocus;
    this._returnFocus = null;
    if (back != null && back.isConnected) {
      back.focus();
    }
  }

  // --------------------------------------------------------------- events

  private _emit(type: string, pick?: ClipPick) {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail: pick == null ? undefined : { pick },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _change(next: ClipPick) {
    if (next !== this.pick) {
      this._emit("clipPickChange", next);
    }
  }

  private readonly _close = () => this._emit("clipPickClose");

  private readonly _start = () => {
    if (this.pick.length > 0) {
      this._emit("clipPickStart", this.pick);
    }
  };

  private readonly _toggleAll = () => this._change(pickAll(this.pick, this.rows));

  private readonly _onScrimDown = (event: PointerEvent) => {
    if (event.target === event.currentTarget) {
      this._close();
    }
  };

  private _toggle(key: string) {
    this._change(togglePick(this.pick, key));
  }

  private _remove(key: string) {
    const index = this.pick.indexOf(key);
    const next = removePick(this.pick, key);
    this._change(next);
    const neighbour = next[Math.min(index, next.length - 1)];
    this._focusAfterRender =
      neighbour != null
        ? { zone: "chip", key: neighbour }
        : { zone: "tile", key };
  }

  private readonly _onKeydown = (event: KeyboardEvent) => {
    if (!this.open) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const tile = target?.closest?.(".clip-tile") as HTMLElement | null;
    const chip = target?.closest?.(".clip-chip") as HTMLElement | null;
    const zone: PickerZone = tile ? "tile" : chip ? "chip" : "other";

    // Every keystroke stops here. The default action still runs, so Tab moves
    // focus and Space on a tile still clicks it.
    event.stopImmediatePropagation();

    if (event.key === "Tab") {
      this._trapTab(event);
      return;
    }

    const intent = pickerKeyIntent(
      {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      },
      zone,
      IS_MAC,
    );
    if (intent === "none") {
      return;
    }
    event.preventDefault();

    const key = (tile ?? chip)?.dataset.key ?? "";
    switch (intent) {
      case "close":
        this._close();
        return;
      case "start":
        this._start();
        return;
      case "selectAll":
        this._toggleAll();
        return;
      case "focusPrev":
      case "focusNext":
      case "focusFirst":
      case "focusLast":
        this._moveFocus(zone === "chip" ? "chip" : "tile", key, intent);
        return;
      case "moveBack":
      case "moveForward":
        this._change(nudgePick(this.pick, key, intent === "moveBack" ? -1 : 1));
        this._focusAfterRender = { zone: "chip", key };
        return;
      case "remove":
        this._remove(key);
        return;
    }
  };

  private _trapTab(event: KeyboardEvent) {
    const card = this.querySelector(".clip-picker");
    if (card == null) {
      return;
    }
    const focusable = Array.from(
      card.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [tabindex='0']",
      ),
    );
    if (focusable.length === 0) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active != null && card.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  private _moveFocus(
    zone: "tile" | "chip",
    key: string,
    intent: "focusPrev" | "focusNext" | "focusFirst" | "focusLast",
  ) {
    const keys =
      zone === "chip" ? [...this.pick] : this.rows.map((row) => row.key);
    if (keys.length === 0) {
      return;
    }
    const at = keys.indexOf(key);
    const index =
      intent === "focusFirst"
        ? 0
        : intent === "focusLast"
          ? keys.length - 1
          : Math.min(
              keys.length - 1,
              Math.max(0, at + (intent === "focusPrev" ? -1 : 1)),
            );
    this._focusKey(zone, keys[index]);
  }

  private _focusKey(zone: "tile" | "chip", key: string) {
    const selector = zone === "chip" ? ".clip-chip" : ".clip-tile";
    const el = Array.from(this.querySelectorAll<HTMLElement>(selector)).find(
      (candidate) => candidate.dataset.key === key,
    );
    el?.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ----------------------------------------------------------------- skim

  private _onTileMove(event: PointerEvent, tile: ClipTile) {
    const el = event.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const fraction =
      rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    el.style.setProperty("--skim", String(Math.min(1, Math.max(0, fraction))));
    el.classList.add("is-skimming");
    const canvas = el.querySelector("canvas");
    if (canvas != null && tile.filetype === "video") {
      this._paintVideo(canvas, tile, skimMs(tile.window, fraction));
    }
  }

  private _onTileLeave(event: PointerEvent, tile: ClipTile) {
    const el = event.currentTarget as HTMLElement;
    el.classList.remove("is-skimming");
    const canvas = el.querySelector("canvas");
    if (canvas != null && tile.filetype === "video") {
      this._paintVideo(canvas, tile, posterMs(tile.window));
    }
  }

  // ----------------------------------------------------------------- tray

  private _chips(): HTMLElement[] {
    return Array.from(this.querySelectorAll<HTMLElement>(".clip-chip"));
  }

  private _centers(): number[] {
    return this._chips().map((chip) => {
      const rect = chip.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
  }

  private _onChipDown(event: PointerEvent, index: number) {
    if (event.button !== 0) {
      return;
    }
    const chip = event.currentTarget as HTMLElement;
    chip.setPointerCapture(event.pointerId);
    const centers = this._centers();
    this._dragPitch =
      centers.length > 1
        ? centers[1] - centers[0]
        : chip.getBoundingClientRect().width;
    this._drag = reduceTrayDrag(this._drag, {
      kind: "press",
      index,
      x: event.clientX,
    }).state;
  }

  private _onChipMove(event: PointerEvent) {
    if (this._drag.kind === "idle") {
      return;
    }
    const step = reduceTrayDrag(this._drag, {
      kind: "move",
      x: event.clientX,
      centers: this._restingCenters(),
    });
    if (step.state === this._drag) {
      return;
    }
    this._drag = step.state;
    this._layoutDrag();
  }

  private _onChipUp(event: PointerEvent) {
    const drag = this._drag;
    const step = reduceTrayDrag(drag, { kind: "release" });
    this._drag = step.state;
    this._clearDrag();
    if (step.commit != null) {
      const key = this.pick[step.commit.from];
      this._change(movePick(this.pick, step.commit.from, step.commit.to));
      this._focusAfterRender = { zone: "chip", key };
    } else if (drag.kind === "pressed") {
      (event.currentTarget as HTMLElement).focus();
    }
  }

  private _onChipCancel() {
    this._drag = reduceTrayDrag(this._drag, { kind: "cancel" }).state;
    this._clearDrag();
  }

  /**
   * Where the chips sit when nothing is being dragged.
   *
   * Their measured rects include the slide this drag has already given them,
   * so the offset is taken back off before they are compared with the pointer.
   */
  private _restingCenters(): number[] {
    return this._chips().map((chip) => {
      const rect = chip.getBoundingClientRect();
      const offset = Number(chip.dataset.offset ?? "0");
      return rect.left + rect.width / 2 - offset;
    });
  }

  private _layoutDrag() {
    const drag = this._drag;
    if (drag.kind !== "dragging") {
      return;
    }
    this._chips().forEach((chip, index) => {
      const offset =
        index === drag.from
          ? drag.dx
          : trayShift(index, drag.from, drag.to, this._dragPitch);
      chip.dataset.offset = String(offset);
      chip.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
      chip.classList.toggle("is-lifted", index === drag.from);
    });
  }

  private _clearDrag() {
    for (const chip of this._chips()) {
      delete chip.dataset.offset;
      chip.style.transform = "";
      chip.classList.remove("is-lifted");
    }
  }

  // --------------------------------------------------------------- paint

  private _paintAll() {
    if (!this.open) {
      return;
    }
    const tiles = new Map(
      clipTiles(this.rows, this.pick).map((tile) => [tile.key, tile]),
    );
    for (const canvas of Array.from(
      this.querySelectorAll<HTMLCanvasElement>("canvas.clip-thumb"),
    )) {
      const tile = tiles.get(canvas.dataset.key ?? "");
      if (tile == null) {
        continue;
      }
      if (tile.filetype === "audio") {
        this._paintWave(canvas, tile);
        continue;
      }
      // A tile under the pointer keeps whatever frame the skim last drew.
      if (canvas.closest(".is-skimming") != null) {
        continue;
      }
      this._paintVideo(canvas, tile, posterMs(tile.window));
    }
  }

  /** Size the backing store to the element, and say whether that cleared it. */
  private _fit(canvas: HTMLCanvasElement): boolean {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) {
      return false;
    }
    canvas.width = w;
    canvas.height = h;
    delete canvas.dataset.drawn;
    return true;
  }

  private _paintVideo(canvas: HTMLCanvasElement, tile: ClipTile, ms: number) {
    const tiles = this._tiles;
    if (tiles == null) {
      return;
    }
    this._fit(canvas);
    const request = thumbRequest(
      tile.localpath,
      ms,
      THUMB_H * tile.aspect,
      THUMB_H,
    );
    if (canvas.dataset.drawn === request.key) {
      return;
    }
    const frame = tiles.get(request.key);
    if (frame == null) {
      // Nothing is cleared: the tile keeps its last frame, or its icon, until
      // this one arrives and `onReady` repaints.
      tiles.request(request);
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }
    // Cover: fill the tile, crop the overflow, keep the picture's shape.
    const scale = Math.max(
      canvas.width / request.tileW,
      canvas.height / request.tileH,
    );
    const dw = request.tileW * scale;
    const dh = request.tileH * scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      frame,
      (canvas.width - dw) / 2,
      (canvas.height - dh) / 2,
      dw,
      dh,
    );
    canvas.dataset.drawn = request.key;
    canvas.classList.add("is-drawn");
  }

  private _paintWave(canvas: HTMLCanvasElement, tile: ClipTile) {
    const peaks = this._peaks;
    if (peaks == null) {
      return;
    }
    this._fit(canvas);
    const data = peaks.get(tile.localpath);
    if (data == null) {
      peaks.request(tile.localpath);
      return;
    }
    if (canvas.dataset.drawn === "wave") {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }
    const { width, height } = canvas;
    const mid = height / 2;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(160, 160, 255, 0.85)";
    tileWave(data, tile.window, width).forEach((column, x) => {
      const top = mid - column.max * mid * 0.9;
      const bottom = mid - column.min * mid * 0.9;
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
    });
    canvas.dataset.drawn = "wave";
    canvas.classList.add("is-drawn");
  }

  // -------------------------------------------------------------- render

  render() {
    if (!this.open) {
      return nothing;
    }

    const tiles = clipTiles(this.rows, this.pick);
    const byKey = new Map(tiles.map((tile) => [tile.key, tile]));
    const chosen = pickedSources(this.pick, this.rows)
      .map((row) => byKey.get(row.key))
      .filter((tile): tile is ClipTile => tile != null);
    const every = allPicked(this.pick, this.rows);

    return html`
      <style>
        .clip-picker-scrim {
          position: fixed;
          inset: 0;
          z-index: 8500;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          background: rgba(0, 0, 0, 0.72);
          animation: clip-picker-fade 140ms ease-out;
        }

        .clip-picker {
          display: flex;
          flex-direction: column;
          width: min(46rem, 92vw);
          max-height: 82vh;
          background: #19181a;
          color: #ffffff;
          border: 1px solid #26262b;
          border-radius: 12px;
          box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.55);
          overflow: hidden;
          animation: clip-picker-rise 140ms ease-out;
        }

        @keyframes clip-picker-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes clip-picker-rise {
          from { opacity: 0; transform: scale(0.98); }
          to { opacity: 1; transform: none; }
        }

        .clip-picker .material-symbols-outlined {
          font-size: 1.1rem;
          line-height: 1;
        }

        .clip-picker-head {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.6rem 0.6rem 0.6rem 0.9rem;
          border-bottom: 1px solid #26262b;
          user-select: none;
        }

        .clip-picker-title {
          font-weight: 600;
          font-size: 0.9rem;
        }

        .clip-picker-count {
          color: #8a8a94;
          font-size: 0.8rem;
        }

        .clip-picker-spacer {
          flex: 1 1 auto;
        }

        /* Plain buttons, not .btn: devent-designsystem.css pads .btn with
           !important, which sizes an icon for a sentence. */
        .clip-picker-ghost,
        .clip-picker-icon {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: #ffffff;
          font-size: 0.8rem;
          cursor: pointer;
        }

        .clip-picker-ghost {
          padding: 0.3rem 0.55rem;
        }

        .clip-picker-icon {
          padding: 0.3rem;
        }

        .clip-picker-ghost:hover:not(:disabled),
        .clip-picker-icon:hover {
          background: #2a2a30;
        }

        .clip-picker-ghost:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .clip-picker-body {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 0.9rem;
        }

        .clip-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
          gap: 0.9rem 0.7rem;
        }

        .clip-cell {
          min-width: 0;
        }

        .clip-tile {
          position: relative;
          display: block;
          width: 100%;
          aspect-ratio: 16 / 9;
          padding: 0;
          border: 1px solid #26262b;
          border-radius: 8px;
          background: #111315;
          overflow: hidden;
          cursor: pointer;
          transition:
            transform 120ms ease-out,
            border-color 120ms ease-out,
            box-shadow 120ms ease-out;
        }

        .clip-tile:hover {
          border-color: #4a4a55;
        }

        .clip-tile:focus-visible,
        .clip-chip:focus-visible {
          outline: 2px solid #8f8ff0;
          outline-offset: 2px;
        }

        .clip-tile.is-selected {
          border-color: #3838d3;
          box-shadow: 0 0 0 2px #3838d3;
          transform: scale(0.97);
        }

        .clip-thumb {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          opacity: 0;
          transition: opacity 120ms ease-out;
        }

        .clip-thumb.is-drawn {
          opacity: 1;
        }

        .clip-tile-fallback,
        .clip-chip-fallback {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #5a5a66;
        }

        .clip-picker .clip-tile-fallback {
          font-size: 1.8rem;
        }

        /* Where the skim is, as a hairline along the bottom edge. */
        .clip-tile-skim {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 2px;
          background: linear-gradient(
            to right,
            #ffffff calc(var(--skim, 0) * 100%),
            transparent 0
          );
          opacity: 0;
        }

        .clip-tile.is-skimming .clip-tile-skim {
          opacity: 0.9;
        }

        .clip-tile-badge {
          position: absolute;
          top: 0.35rem;
          left: 0.35rem;
          min-width: 1.35rem;
          height: 1.35rem;
          padding: 0 0.3rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          border: 1.5px solid rgba(255, 255, 255, 0.85);
          background: rgba(0, 0, 0, 0.35);
          color: #ffffff;
          font-size: 0.75rem;
          font-weight: 700;
          opacity: 0;
          transition: opacity 120ms ease-out;
        }

        .clip-tile:hover .clip-tile-badge,
        .clip-tile:focus-visible .clip-tile-badge {
          opacity: 1;
        }

        .clip-tile.is-selected .clip-tile-badge {
          opacity: 1;
          border-color: #3838d3;
          background: #3838d3;
        }

        .clip-tile-meta {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          display: flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.9rem 0.4rem 0.3rem;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
          color: #ffffff;
          font-size: 0.7rem;
          pointer-events: none;
        }

        .clip-picker .clip-tile-meta .material-symbols-outlined {
          font-size: 0.9rem;
        }

        .clip-tile-time {
          margin-left: auto;
          font-variant-numeric: tabular-nums;
        }

        .clip-tile-name {
          display: flex;
          align-items: baseline;
          gap: 0.3rem;
          margin-top: 0.35rem;
          font-size: 0.75rem;
          color: #d8d8de;
          min-width: 0;
        }

        .clip-tile-name > span:first-child {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .clip-tile-at {
          flex: 0 0 auto;
          color: #8a8a94;
          font-variant-numeric: tabular-nums;
        }

        .clip-picker-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.4rem;
          padding: 2.5rem 0;
          color: #8a8a94;
          font-size: 0.85rem;
        }

        .clip-picker .clip-picker-empty .material-symbols-outlined {
          font-size: 2.2rem;
        }

        .clip-picker-foot {
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.6rem 0.9rem;
          border-top: 1px solid #26262b;
        }

        .clip-tray {
          flex: 1 1 auto;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.25rem 0.1rem;
          overflow-x: auto;
          overflow-y: hidden;
        }

        .clip-chip {
          position: relative;
          flex: 0 0 auto;
          width: 4rem;
          height: 2.25rem;
          border-radius: 6px;
          border: 1px solid #3838d3;
          background: #111315;
          overflow: hidden;
          cursor: grab;
          touch-action: none;
          user-select: none;
          transition: transform 120ms ease-out;
        }

        .clip-chip.is-lifted {
          z-index: 1;
          cursor: grabbing;
          transition: none;
          box-shadow: 0 0.4rem 1rem rgba(0, 0, 0, 0.6);
          scale: 1.06;
        }

        .clip-chip-number {
          position: absolute;
          left: 0.2rem;
          top: 0.2rem;
          min-width: 1.05rem;
          height: 1.05rem;
          padding: 0 0.2rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: #3838d3;
          color: #ffffff;
          font-size: 0.65rem;
          font-weight: 700;
        }

        .clip-chip-grip,
        .clip-chip-remove {
          position: absolute;
          top: 0.15rem;
          right: 0.15rem;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.05rem;
          height: 1.05rem;
          padding: 0;
          border: none;
          border-radius: 999px;
          background: rgba(0, 0, 0, 0.55);
          color: #ffffff;
          opacity: 0;
          transition: opacity 120ms ease-out;
        }

        .clip-chip-grip {
          left: auto;
          top: auto;
          bottom: 0.15rem;
          background: transparent;
          pointer-events: none;
        }

        .clip-chip-remove {
          cursor: pointer;
        }

        .clip-picker .clip-chip-grip .material-symbols-outlined,
        .clip-picker .clip-chip-remove .material-symbols-outlined {
          font-size: 0.8rem;
        }

        .clip-chip:hover .clip-chip-remove,
        .clip-chip:focus-visible .clip-chip-remove,
        .clip-chip:hover .clip-chip-grip {
          opacity: 1;
        }

        .clip-tray-empty {
          width: 4rem;
          height: 2.25rem;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px dashed #3a3a44;
          border-radius: 6px;
          color: #5a5a66;
        }

        /* The !important answers devent-designsystem.css, which pads .btn
           with !important. */
        .clip-picker-start {
          flex: 0 0 auto;
          display: inline-flex !important;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.8rem !important;
        }

        .clip-picker-start-count {
          min-width: 1.15rem;
          height: 1.15rem;
          padding: 0 0.25rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.22);
          font-size: 0.7rem;
          font-weight: 700;
        }

        @media (prefers-reduced-motion: reduce) {
          .clip-picker-scrim,
          .clip-picker,
          .clip-tile,
          .clip-chip,
          .clip-thumb {
            animation-duration: 1ms;
            transition-duration: 1ms;
          }
        }
      </style>

      <div class="clip-picker-scrim" @pointerdown=${this._onScrimDown}>
        <div class="clip-picker" role="dialog" aria-modal="true" aria-label="Clips">
          <div class="clip-picker-head">
            <span class="material-symbols-outlined" aria-hidden="true"
              >video_library</span
            >
            <span class="clip-picker-title">Clips</span>
            <span class="clip-picker-count">${this.rows.length}</span>
            <span class="clip-picker-spacer"></span>
            <button
              type="button"
              class="clip-picker-ghost"
              ?disabled=${this.rows.length === 0}
              aria-pressed=${every ? "true" : "false"}
              title=${IS_MAC ? "⌘A" : "Ctrl+A"}
              @click=${this._toggleAll}
            >
              <span class="material-symbols-outlined" aria-hidden="true"
                >${every ? "deselect" : "select_all"}</span
              >
              <span>${every ? "None" : "All"}</span>
            </button>
            <button
              type="button"
              class="clip-picker-icon"
              aria-label="Close"
              title="Esc"
              @click=${this._close}
            >
              <span class="material-symbols-outlined" aria-hidden="true"
                >close</span
              >
            </button>
          </div>

          <div class="clip-picker-body">
            ${tiles.length === 0 ? this._renderEmpty() : this._renderGrid(tiles)}
          </div>

          <div class="clip-picker-foot">
            <div
              class="clip-tray"
              role="listbox"
              aria-orientation="horizontal"
              aria-label="Order"
            >
              ${chosen.length === 0
                ? html`<div class="clip-tray-empty" aria-hidden="true">
                    <span class="material-symbols-outlined">add</span>
                  </div>`
                : repeat(
                    chosen,
                    (tile) => tile.key,
                    (tile, index) => this._renderChip(tile, index),
                  )}
            </div>
            <button
              type="button"
              class="btn btn-sm btn-primary clip-picker-start"
              ?disabled=${this.pick.length === 0}
              title=${IS_MAC ? "⌘↩" : "Ctrl+Enter"}
              @click=${this._start}
            >
              <span class="material-symbols-outlined" aria-hidden="true"
                >subtitles</span
              >
              <span>Start</span>
              ${this.pick.length > 0
                ? html`<span class="clip-picker-start-count"
                    >${this.pick.length}</span
                  >`
                : nothing}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderEmpty() {
    return html`<div class="clip-picker-empty">
      <span class="material-symbols-outlined" aria-hidden="true">movie_off</span>
      <span>No clips</span>
    </div>`;
  }

  private _renderGrid(tiles: ClipTile[]) {
    return html`<div class="clip-grid">
      ${repeat(
        tiles,
        (tile) => tile.key,
        (tile) => html`<div class="clip-cell">
          <button
            type="button"
            class="clip-tile ${tile.selected ? "is-selected" : ""}"
            data-key=${tile.key}
            aria-pressed=${tile.selected ? "true" : "false"}
            aria-label=${`${tile.name} ${tile.durationLabel}`}
            title=${tile.name}
            @click=${() => this._toggle(tile.key)}
            @pointermove=${(e: PointerEvent) => this._onTileMove(e, tile)}
            @pointerleave=${(e: PointerEvent) => this._onTileLeave(e, tile)}
          >
            <span class="clip-tile-fallback material-symbols-outlined" aria-hidden="true"
              >${tile.icon}</span
            >
            <canvas class="clip-thumb" data-key=${tile.key}></canvas>
            <span class="clip-tile-skim" aria-hidden="true"></span>
            <span class="clip-tile-badge" aria-hidden="true">${tile.number ?? ""}</span>
            <span class="clip-tile-meta" aria-hidden="true">
              <span class="material-symbols-outlined">${tile.icon}</span>
              ${tile.twin
                ? html`<span class="material-symbols-outlined">link</span>`
                : nothing}
              <span class="clip-tile-time">${tile.durationLabel}</span>
            </span>
          </button>
          <div class="clip-tile-name">
            <span title=${tile.name}>${tile.name}</span>
            ${tile.startLabel != null
              ? html`<span class="clip-tile-at">${tile.startLabel}</span>`
              : nothing}
          </div>
        </div>`,
      )}
    </div>`;
  }

  private _renderChip(tile: ClipTile, index: number) {
    return html`<div
      class="clip-chip"
      role="option"
      aria-selected="true"
      tabindex="0"
      data-key=${tile.key}
      aria-label=${`${index + 1} ${tile.name}`}
      title=${tile.name}
      @pointerdown=${(e: PointerEvent) => this._onChipDown(e, index)}
      @pointermove=${(e: PointerEvent) => this._onChipMove(e)}
      @pointerup=${(e: PointerEvent) => this._onChipUp(e)}
      @pointercancel=${() => this._onChipCancel()}
    >
      <span class="clip-chip-fallback material-symbols-outlined" aria-hidden="true"
        >${tile.icon}</span
      >
      <canvas class="clip-thumb" data-key=${tile.key}></canvas>
      <span class="clip-chip-number" aria-hidden="true">${index + 1}</span>
      <span class="clip-chip-grip" aria-hidden="true">
        <span class="material-symbols-outlined">drag_indicator</span>
      </span>
      <button
        type="button"
        class="clip-chip-remove"
        aria-label="Remove"
        tabindex="-1"
        @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
        @click=${() => this._remove(tile.key)}
      >
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    </div>`;
  }
}
