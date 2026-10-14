import { LitElement, html, type PropertyValues } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { createTextElement } from "../../features/element/textElement";
import { addTextClip } from "../../features/editor/actions";
import { projectBakeHz } from "../../features/editor/frameRate";
import {
  DEFAULT_FONT,
  ensureFontFace,
  type FontEntry,
} from "../../features/font/fontFaces";
import type { PresetFrame } from "../../features/font/textPresetOptions";
import {
  PRESET_GROUPS,
  PRESET_GROUP_LABEL,
  buildTextPresets,
  lookPreset,
  presetMatches,
  type PresetGroup,
  type TextPreset,
} from "../../features/font/textPresets";
import { revealStep } from "../../features/motion/browseMotion";
import {
  cascade,
  prefersReducedMotion,
  viewOf,
} from "../../features/motion/cascade";
import {
  observeVisibility,
  unobserveVisibility,
} from "../../features/asset/tileVisibility";
import {
  TEXT_ANIMATIONS,
  applyTextAnimation,
  type TextAnimation,
} from "../../features/text/textAnimations";
import {
  presetElement,
  tileSpecFor,
  type TileSpec,
} from "../../features/text/textTile";
import { TextTilePainter } from "../../features/text/textTilePainter";
import { normalizeFps } from "../../features/timeline/frames";
import { renderOptionStore } from "../../states/renderOptionStore";

/** A tile's canvas: twice the effect tiles' 192x108, so lettering stays crisp. */
const TILE_W = 384;
const TILE_H = 216;

/** One animated tile: the move, and the preset it wears. */
type AnimatedTile = { animation: TextAnimation; look: TextPreset };

/** What a `data-tile` key draws. */
type TileSource = { preset: TextPreset; animation: TextAnimation | null };

function frameNow(): PresetFrame {
  const { w, h } = renderOptionStore.getState().options.previewSize;
  return { w, h };
}

/** Every word of the query somewhere in `fields`, as `presetMatches` reads one. */
function matchesAll(query: string, fields: string[]): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields.join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/**
 * The "Text" asset panel, laid out the way every other asset browser is: a
 * search bar, then sections of tiles, each a 16:9 well over a name.
 *
 * Basic holds the plain text clip. Animated holds a look and a way of
 * arriving per tile, and plays it while the pointer is over the tile. The
 * rest are the text presets by their main ingredient: Clean, Outline, Box,
 * Shadow, Glow and Gradient.
 *
 * Every well is drawn by the renderer from the element the click adds
 * (`features/text/textTile.ts`, `textTilePainter.ts`), so a tile cannot show a
 * look the clip does not have. The faces are injected before anything draws,
 * since `renderText` resolves `fontname` as a CSS family.
 *
 * Every string in this panel is English and stays English: it is not routed
 * through `LocaleController`. The families are Latin-only specimens, and a
 * Hangul label under lettering that cannot render Hangul misrepresents the
 * face.
 */
@customElement("control-ui-text")
export class ControlText extends LitElement {
  @state() private presets: TextPreset[] = [];
  @state() private loaded = false;
  @state() private query = "";
  @state() private frame: PresetFrame = frameNow();

  private painter = new TextTilePainter();
  private sources = new Map<string, TileSource>();
  private specs = new Map<string, TileSpec>();
  private observed = new Set<HTMLCanvasElement>();
  private painted = new Set<HTMLCanvasElement>();
  private teardown: Array<() => void> = [];
  private seen = false;
  private revealed = false;
  private recascade = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    void this.loadPresets();

    // The tiles are laid out in the frame being edited, so a new frame size
    // (a settings change, a template tab) redraws them in it.
    this.teardown.push(
      renderOptionStore.subscribe((state) => {
        const { w, h } = state.options.previewSize;
        if (w !== this.frame.w || h !== this.frame.h) {
          this.frame = { w, h };
        }
      }),
    );

    // The panel is mounted at startup inside a hidden tab. Its first cascade
    // waits for the tab to be shown, or it would play to nobody.
    const visibility = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.seen = true;
        this.reveal();
      }
    });
    visibility.observe(this);
    this.teardown.push(() => visibility.disconnect());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.painter.dispose();
    for (const canvas of this.observed) {
      unobserveVisibility(canvas);
    }
    this.observed.clear();
    for (const release of this.teardown) {
      release();
    }
    this.teardown = [];
  }

  private async loadPresets() {
    const result: { status?: number; fonts?: FontEntry[] } =
      await window.electronAPI.req.font.getPresetFontLists();

    const fonts = result?.fonts ?? [];

    // Registered before the tiles exist, so no tile waits on a face nobody
    // asked for. The painter still waits for each one to load before drawing.
    for (const font of fonts) {
      ensureFontFace(font);
    }

    // Assigning to an @state field is what schedules the re-render.
    this.presets = buildTextPresets(fonts);
    this.loaded = true;
  }

  protected willUpdate(changed: PropertyValues) {
    if (changed.has("frame") || changed.has("presets")) {
      this.specs.clear();
    }
  }

  protected updated(changed: PropertyValues) {
    // Canvases that left the DOM stop being watched; new ones start.
    for (const canvas of [...this.observed]) {
      if (!canvas.isConnected) {
        unobserveVisibility(canvas);
        this.observed.delete(canvas);
        this.painted.delete(canvas);
      }
    }
    for (const canvas of this.querySelectorAll<HTMLCanvasElement>(
      "canvas[data-tile]",
    )) {
      if (!this.observed.has(canvas)) {
        this.observed.add(canvas);
        observeVisibility(canvas, (visible) => {
          if (visible && !this.painted.has(canvas)) {
            this.paint(canvas);
          }
        });
      }
    }

    // A new frame size re-lays every tile already drawn. The ones not drawn
    // yet will be drawn in it when they scroll into reach.
    if (changed.has("frame") || changed.has("presets")) {
      for (const canvas of this.painted) {
        this.paint(canvas);
      }
    }

    if (changed.has("query") && this.revealed) {
      this.recascade = true;
    }
    this.reveal();
  }

  /** The panel's blocks arriving: once when first shown, again per search. */
  private reveal() {
    if (!this.seen || !this.loaded) {
      return;
    }
    const first = !this.revealed;
    if (!first && !this.recascade) {
      return;
    }
    const blocks = Array.from(
      this.querySelectorAll<HTMLElement>("[data-cascade]"),
    ).filter((block) => first || block.dataset.cascade !== "once");
    if (blocks.length === 0) {
      return;
    }
    this.revealed = true;
    this.recascade = false;
    cascade(
      blocks,
      viewOf(this.closest(".tab-content")),
      revealStep(prefersReducedMotion()),
    );
  }

  private specFor(key: string): TileSpec | null {
    const cached = this.specs.get(key);
    if (cached != null) {
      return cached;
    }
    const source = this.sources.get(key);
    if (source == null) {
      return null;
    }
    const spec = tileSpecFor(source.preset, source.animation, this.frame);
    this.specs.set(key, spec);
    return spec;
  }

  private paint(canvas: HTMLCanvasElement) {
    const spec = this.specFor(canvas.dataset.tile ?? "");
    if (spec == null) {
      return;
    }
    this.painted.add(canvas);
    void this.painter.rest(canvas, spec);
  }

  private animatedTiles(): AnimatedTile[] {
    const tiles: AnimatedTile[] = [];
    for (const animation of TEXT_ANIMATIONS) {
      const look = lookPreset(animation.look, this.presets, DEFAULT_FONT);
      if (look != null) {
        tiles.push({ animation, look });
      }
    }
    return tiles;
  }

  // ------------------------------------------------------------------ clicks

  private handleAddPlain = () => {
    addTextClip(createTextElement({}));
  };

  private handleAddPreset(preset: TextPreset) {
    // The face was registered at load, but `ensureFontFace` is idempotent and
    // a preset must never produce an element in a family the document cannot
    // resolve.
    ensureFontFace({ path: preset.path, name: preset.family, type: preset.type });
    addTextClip(presetElement(preset, null, frameNow()));
  }

  private handleAddAnimated({ animation, look }: AnimatedTile) {
    ensureFontFace({ path: look.path, name: look.family, type: look.type });
    const fps = normalizeFps(renderOptionStore.getState().options?.fps);
    addTextClip(presetElement(look, animation, frameNow()), (doc, id) =>
      applyTextAnimation(doc, id, animation, {
        bakeHz: projectBakeHz(),
        frameMs: 1000 / fps,
      }),
    );
  }

  private handleEnter(event: Event) {
    // A finger has no hover: a tap is an enter and a click together, and the
    // click has already added the clip. The resting frame is mid-move, which
    // is what a phone shows instead.
    if (window.matchMedia?.("(pointer: coarse)").matches) {
      return;
    }
    const canvas = (event.currentTarget as HTMLElement).querySelector("canvas");
    if (canvas != null) {
      this.painter.play(canvas);
    }
  }

  private handleLeave(event: Event) {
    const canvas = (event.currentTarget as HTMLElement).querySelector("canvas");
    if (canvas != null) {
      this.painter.stop(canvas);
    }
  }

  private handleInputQuery(event: Event) {
    this.query = (event.target as HTMLInputElement).value;
  }

  // ------------------------------------------------------------------ render

  private well(key: string) {
    return html`<div class="asset-thumb">
      <canvas
        class="asset-thumb-img"
        data-tile=${key}
        width=${TILE_W}
        height=${TILE_H}
      ></canvas>
    </div>`;
  }

  private presetTile(preset: TextPreset) {
    const key = `style:${preset.id}`;
    this.sources.set(key, { preset, animation: null });
    return html`<div
      class="asset asset-tile"
      data-cascade
      title=${preset.label}
      @click=${() => this.handleAddPreset(preset)}
    >
      ${this.well(key)}
      <span class="asset-name">${preset.fontLabel}</span>
      <span class="asset-note">${preset.styleLabel}</span>
    </div>`;
  }

  private animatedTile(tile: AnimatedTile) {
    const key = `animated:${tile.animation.id}`;
    this.sources.set(key, { preset: tile.look, animation: tile.animation });
    return html`<div
      class="asset asset-tile"
      data-cascade
      title=${`${tile.animation.name}, ${tile.look.label}`}
      @click=${() => this.handleAddAnimated(tile)}
      @mouseenter=${this.handleEnter}
      @mouseleave=${this.handleLeave}
    >
      ${this.well(key)}
      <span class="asset-name">${tile.animation.name}</span>
      <span class="asset-note">${tile.look.styleLabel}</span>
    </div>`;
  }

  private section(title: string, count: number, tiles: unknown) {
    return html`<section class="browse-section">
      <div class="browse-section-head" data-cascade="once">
        <span class="browse-section-title">${title}</span>
        <span class="browse-section-count">${count}</span>
      </div>
      <div class="asset-grid browse-grid">${tiles}</div>
    </section>`;
  }

  render() {
    const query = this.query;
    this.sources.clear();

    const showPlain = matchesAll(query, ["Text", "Basic", "Default", "Plain"]);
    const animated = this.loaded
      ? this.animatedTiles().filter((tile) =>
          matchesAll(query, [
            "Animated",
            tile.animation.name,
            tile.look.label,
          ]),
        )
      : [];
    const groups = PRESET_GROUPS.map((group) => ({
      group,
      presets: this.presets.filter(
        (preset) => preset.group === group && presetMatches(preset, query),
      ),
    })).filter((entry) => entry.presets.length > 0);

    const nothing = !showPlain && animated.length === 0 && groups.length === 0;

    return html`
      <div class="browse-bar is-floating">
        <label class="browse-field">
          <span class="material-symbols-outlined browse-field-icon"
            >search</span
          >
          <input
            type="search"
            class="browse-input"
            spellcheck="false"
            placeholder="Search text"
            .value=${query}
            @input=${this.handleInputQuery}
          />
        </label>
      </div>

      ${showPlain
        ? this.section(
            "Basic",
            1,
            html`<div
              class="asset asset-tile"
              data-cascade
              data-tutorial="text-default"
              title="Text"
              @click=${this.handleAddPlain}
            >
              <div class="asset-thumb">
                <span class="material-symbols-outlined asset-thumb-icon"
                  >text_fields</span
                >
              </div>
              <span class="asset-name">Text</span>
              <span class="asset-note">Default</span>
            </div>`,
          )
        : null}
      ${animated.length > 0
        ? this.section(
            "Animated",
            animated.length,
            repeat(
              animated,
              (tile) => tile.animation.id,
              (tile) => this.animatedTile(tile),
            ),
          )
        : null}
      ${repeat(
        groups,
        ({ group }) => group,
        ({ group, presets }) =>
          this.section(
            PRESET_GROUP_LABEL[group as PresetGroup],
            presets.length,
            repeat(
              presets,
              (preset) => preset.id,
              (preset) => this.presetTile(preset),
            ),
          ),
      )}
      ${nothing
        ? html`<div class="browse-empty">
            <div class="browse-empty-icon">
              <span class="material-symbols-outlined">search_off</span>
            </div>
            <div class="browse-empty-title">No matches</div>
            <div class="browse-empty-text">
              Try a font, a look like outline or neon, or an animation.
            </div>
          </div>`
        : null}
    `;
  }
}
