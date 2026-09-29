import { LitElement, html, nothing, render } from "lit";
import { customElement, state } from "lit/decorators.js";
import { assetStore } from "../../states/assetStore";
import { LocaleController } from "../../controllers/locale";
import { applyMenuPlacement, type Anchor } from "../menu/menuPlacement";
import {
  ASSET_SORT_KEYS,
  AssetSort,
  SORT_KEY_LABEL,
  directionRows,
  withSortDirection,
  withSortKey,
} from "./assetSort";

/**
 * The asset panel's Sort By button and its menu, Finder's toolbar menu at bar
 * height: a check column, the five keys, a divider, then the two directions in
 * the chosen key's own words. Choosing a row applies it and closes the menu.
 *
 * What each row means is `assetSort.ts`'s; this only draws it and hands the
 * choice to `assetStore`.
 *
 * **The menu is portalled to `document.body`.** The bar it opens from is
 * `position: sticky` with `z-index: 1`, which is a stacking context, so a
 * fixed menu inside it ranks at 6000 among the bar's children and at 1 against
 * the rest of the page. With the timeline dragged tall the menu crosses into
 * it, and the timeline header, the ruler and the column splitter (300 to 400)
 * all paint over it; the splitters are transparent, so what the user sees is a
 * row that ignores the click. `menuDropdown.ts`'s submenus and the hover
 * preview live on `<body>` for the same reason.
 */
@customElement("asset-sort-menu")
export class AssetSortMenu extends LitElement {
  @state()
  sort: AssetSort = assetStore.getState().sort;

  /** Where the open menu hangs from, or null while it is closed. */
  @state()
  private anchor: Anchor | null = null;

  private lc = new LocaleController(this);
  private unsubscribe?: () => void;
  private portal: HTMLDivElement | null = null;
  /** Opened from the keyboard, so the checked row takes focus once it exists. */
  private focusOnOpen = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();

    this.sort = assetStore.getState().sort;
    this.unsubscribe = assetStore.subscribe((state) => {
      this.sort = state.sort;
    });

    // Capture, and `pointerdown` rather than `mousedown`: a surface that calls
    // `preventDefault` on its pointer event suppresses the compatibility mouse
    // event, and a press there would leave the menu standing.
    window.addEventListener("pointerdown", this.onWindowPointerDown, true);
    // Capture as well, for `onWindowKeyDown`'s reason.
    window.addEventListener("keydown", this.onWindowKeyDown, true);
    window.addEventListener("resize", this.close);
    window.addEventListener("blur", this.close);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = undefined;

    window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
    window.removeEventListener("keydown", this.onWindowKeyDown, true);
    window.removeEventListener("resize", this.close);
    window.removeEventListener("blur", this.close);

    // `updated` will not run again for a detached element, and the portal is
    // not a descendant, so nothing else would take it away.
    this.anchor = null;
    this.removePortal();
  }

  // ------------------------------------------------------------ open, close

  private get trigger(): HTMLElement | null {
    return this.querySelector(".asset-sort-trigger");
  }

  private toggle = (e: MouseEvent) => {
    if (this.anchor != null) {
      this.close();
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // `detail` counts clicks, and a click synthesised by Enter or Space has none.
    this.focusOnOpen = e.detail === 0;
    this.anchor = { x: rect.right, y: rect.bottom + 4 };
  };

  private close = () => {
    if (this.anchor != null) {
      this.anchor = null;
    }
  };

  private choose(next: AssetSort, e: MouseEvent) {
    assetStore.getState().setSort(next);
    this.close();
    if (e.detail === 0) {
      this.trigger?.focus();
    }
  }

  /**
   * A press anywhere but the menu or its button closes it. The button is
   * exempt so that its own click can do the closing; exempting only the menu
   * would close it here and reopen it on the click.
   */
  private onWindowPointerDown = (e: PointerEvent) => {
    if (this.anchor == null) {
      return;
    }
    const target = e.target as Element | null;
    if (target?.closest?.(".asset-sort-trigger, .asset-sort-menu") != null) {
      return;
    }
    this.close();
  };

  /**
   * The keyboard while the menu is open, on `window` in the capture phase.
   *
   * It has to run first. Bootstrap 5.0.2's dropdown binds `keydown` on
   * `document` in the *capture* phase for anything inside a `.dropdown-menu`,
   * and for an arrow or Escape it calls `stopPropagation` and then looks for
   * the menu's `[data-bs-toggle]` button. This menu has none, so the handler
   * throws, and the key never reaches a listener on the menu itself: arrows
   * did nothing and Escape left the menu open.
   *
   * With focus on a row, the keys the menu uses stop here, which also keeps
   * them from `Timeline.ts`'s `document` listener: an arrow would move the
   * playhead, and Space would start playback instead of choosing the row.
   * Stopping propagation does not cancel a button's own activation, so Space
   * and Enter still click the row. With focus elsewhere (the menu opened by
   * mouse), Escape closes it and is left to travel on.
   */
  private onWindowKeyDown = (e: KeyboardEvent) => {
    if (this.anchor == null) {
      return;
    }

    const target = e.target as Element | null;
    const inMenu = target?.closest?.(".asset-sort-menu") != null;

    if (e.key === "Escape") {
      this.close();
      this.trigger?.focus();
      if (inMenu) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (!inMenu) {
      return;
    }

    if (e.key === "Tab") {
      this.close();
      return;
    }
    if (e.key === " " || e.key === "Enter") {
      e.stopPropagation();
      return;
    }

    const rows = Array.from(
      this.portal?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ??
        [],
    );
    const at = rows.indexOf(target as HTMLElement);
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = (at + 1) % rows.length;
        break;
      case "ArrowUp":
        next = at <= 0 ? rows.length - 1 : at - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      default:
        return;
    }

    e.preventDefault();
    e.stopPropagation();
    rows[next]?.focus();
  };

  // ----------------------------------------------------------------- portal

  /**
   * Draw the open menu into its portal, then measure and place it.
   *
   * After Lit's render and not inside it, because the placement depends on the
   * menu's measured size. The menu starts `visibility: hidden` so it is never
   * seen at (0, 0) for the frame before it is placed.
   */
  protected updated(): void {
    const anchor = this.anchor;
    if (anchor == null) {
      this.removePortal();
      return;
    }

    if (this.portal == null) {
      this.portal = document.createElement("div");
      document.body.appendChild(this.portal);
    }
    render(this.templateMenu(), this.portal, { host: this });

    const menu = this.portal.querySelector<HTMLElement>(".asset-sort-menu");
    if (menu == null) {
      return;
    }
    applyMenuPlacement(menu, anchor, { alignRight: true });
    menu.style.visibility = "visible";

    if (this.focusOnOpen) {
      this.focusOnOpen = false;
      menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    }
  }

  private removePortal() {
    if (this.portal == null) {
      return;
    }
    render(nothing, this.portal);
    this.portal.remove();
    this.portal = null;
  }

  // -------------------------------------------------------------- templates

  render() {
    const open = this.anchor != null;
    const label = `${this.lc.t("setting.sort_by")}: ${this.lc.t(
      SORT_KEY_LABEL[this.sort.key],
    )}`;

    return html`<button
      type="button"
      class="browse-btn asset-sort-trigger"
      title=${label}
      aria-label=${label}
      aria-haspopup="menu"
      aria-expanded=${open ? "true" : "false"}
      @click=${this.toggle}
    >
      <span class="material-symbols-outlined">sort</span>
    </button>`;
  }

  private templateMenu() {
    const sort = this.sort;
    const title = this.lc.t("setting.sort_by");

    return html`<ul
      class="dropdown-menu show browse-menu asset-sort-menu"
      role="menu"
      aria-label=${title}
      style="position: fixed; top: 0px; left: 0px; z-index: 6000; visibility: hidden;"
    >
      <li class="dropdown-header" role="presentation">${title}</li>
      ${ASSET_SORT_KEYS.map((key) =>
        this.templateRow(
          this.lc.t(SORT_KEY_LABEL[key]),
          sort.key == key,
          (e) => this.choose(withSortKey(sort, key), e),
        ),
      )}
      <li role="separator"><hr class="dropdown-divider" /></li>
      ${directionRows(sort.key).map((row) =>
        this.templateRow(
          this.lc.t(row.labelKey),
          sort.direction == row.direction,
          (e) => this.choose(withSortDirection(sort, row.direction), e),
        ),
      )}
    </ul>`;
  }

  /**
   * One radio row. The check is always in the markup and shown by
   * `aria-checked`, so every label starts at the same x whether or not its row
   * is the chosen one. It is `aria-hidden` because a Material Symbols glyph is
   * a ligature of its own name: left exposed, every row would be announced as
   * "check Name", and `aria-checked` already says which one is chosen.
   */
  private templateRow(
    label: string,
    checked: boolean,
    run: (e: MouseEvent) => void,
  ) {
    return html`<li role="none">
      <button
        type="button"
        class="dropdown-item dropdown-item-sm dropdown-item-icon"
        role="menuitemradio"
        aria-checked=${checked ? "true" : "false"}
        @click=${run}
      >
        <span
          class="material-symbols-outlined browse-menu-check"
          aria-hidden="true"
          >check</span
        >${label}
      </button>
    </li>`;
  }
}
