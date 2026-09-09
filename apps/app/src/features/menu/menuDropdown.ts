import { LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { applyMenuPlacement, applySubmenuPlacement } from "./menuPlacement";

/**
 * How long a submenu survives the pointer leaving it, in ms.
 *
 * The pointer travelling from a trigger row to the submenu beside it crosses a
 * few pixels of neither, and on the diagonal it crosses the row *below* the
 * trigger as well. Closing on the first `mouseleave` makes that ordinary
 * movement dismiss the menu the user is aiming at. Radix solves this with a
 * safe-triangle; a short grace period is the same idea, cheaply.
 */
const SUBMENU_CLOSE_MS = 140;

@customElement("menu-dropdown-body")
export class MenuDropdownBody extends LitElement {
  /** Viewport coordinates of the click that opened this menu. */
  private topPx: number;
  private leftPx: number;

  /**
   * Stored once, because `disconnectedCallback` has to be able to remove it.
   *
   * `removeEventListener(this.dismiss.bind(this))` — which is what this used to
   * do — hands over a *newly* bound function that was never registered, so the
   * listener stayed on `document` for the life of the app and every menu ever
   * opened left one behind.
   */
  private readonly onDocumentClick = () => this.dismiss();

  /**
   * Hovering anything that is not a submenu closes the open one.
   *
   * Without this an open submenu stays open while the pointer walks down the
   * rows beneath its trigger, so the menu ends up showing two selected paths at
   * once. `menu-dropdown-sub` handles its own siblings; this is the other half,
   * for plain rows.
   */
  private readonly onPointerOver = (event: Event) => {
    const target = event.target as Element | null;
    if (target?.closest("menu-dropdown-sub") != null) {
      return;
    }
    this.closeSubmenus();
  };

  /** A submenu is placed against its trigger's box, which scrolling moves. */
  private readonly onScroll = () => this.closeSubmenus();

  private closeSubmenus() {
    this.querySelectorAll("menu-dropdown-sub").forEach((sub) => {
      (sub as MenuDropdownSub).closeSubmenu();
    });
  }

  constructor() {
    super();
    // Named for what they are. They used to be `x` and `y` holding, in order,
    // the `top` and `left` attributes — the caller passes `top="${clientY}"`,
    // so `x` was a vertical coordinate.
    this.topPx = Number(this.getAttribute("top") ?? 0);
    this.leftPx = Number(this.getAttribute("left") ?? 0);
  }

  render() {
    const innerElements = this.innerHTML;

    this.innerHTML = this.template();
    this.style.display = "inline-block";
    const ul = this.querySelector("ul") as HTMLElement;
    ul.innerHTML = innerElements;
  }

  /**
   * The menu, hidden and unpositioned.
   *
   * `position: fixed` rather than Bootstrap's `position-absolute`: the
   * coordinates handed in are `clientX`/`clientY`, which are viewport
   * coordinates. Absolute positioning only agreed with them by accident —
   * `#menuRightClick` is a child of `<body>` and the document never scrolls, so
   * the initial containing block happened to line up.
   *
   * `visibility: hidden` because the menu has to be laid out before it can be
   * measured, and measuring is what decides whether it opens up or down.
   * Without it the menu paints once at the wrong place and jumps.
   */
  template() {
    return `
        <ul class="dropdown-menu show" style="position: fixed; top: 0px; left: 0px; z-index: 6000; visibility: hidden;">

        </ul>`;
  }

  private dismiss() {
    setTimeout(() => {
      this.remove();
    }, 200);
  }

  connectedCallback() {
    this.render();

    // Synchronously, and not from a Lit lifecycle hook: this class never calls
    // `super.connectedCallback()`, so Lit's reactive update cycle does not run
    // and `updated()` would never fire. The items are already in the DOM at
    // this point, so `offsetHeight` is the real height.
    const ul = this.querySelector("ul") as HTMLElement | null;
    if (ul != null) {
      applyMenuPlacement(ul, { x: this.leftPx, y: this.topPx });
      ul.style.visibility = "visible";
    }

    document.addEventListener("click", this.onDocumentClick);
    this.addEventListener("mouseover", this.onPointerOver);
    ul?.addEventListener("scroll", this.onScroll);
  }

  disconnectedCallback() {
    document.removeEventListener("click", this.onDocumentClick);
    this.removeEventListener("mouseover", this.onPointerOver);
    this.querySelector("ul")?.removeEventListener("scroll", this.onScroll);
  }
}

@customElement("menu-dropdown-item")
export class MenuDropdownItem extends LitElement {
  name: string;
  /** A Material Symbols glyph name, or "" for a text-only item. */
  icon: string;

  constructor() {
    super();

    this.name = this.getAttribute("item-name") || "untitle";
    this.icon = this.getAttribute("item-icon") || "";
  }

  render() {
    const template = this.template();
    this.innerHTML = template;
  }

  template() {
    const icon = this.icon
      ? `<span class="material-symbols-outlined icon-xs">${this.icon}</span>`
      : "";
    return `<li><a class="dropdown-item dropdown-item-sm dropdown-item-icon">${icon}${this.name}</a></li>`;
  }

  connectedCallback() {
    this.render();
  }
}

/**
 * A row that opens a menu of its own beside it.
 *
 * Modelled on shadcn/ui's `ContextMenuSub`: the trigger is an ordinary row
 * carrying a `chevron_right` pushed to the far edge by `margin-left: auto` —
 * their `ml-auto` — and the panel it opens is a `.dropdown-menu` anchored to
 * the trigger's right edge, flipping to its left when the window has no room.
 * Hover opens it and a click toggles it, which is what Radix's trigger does in
 * both directions.
 *
 * ```html
 * <menu-dropdown-sub item-name="Animate" item-icon="animation">
 *   <menu-dropdown-item onclick="…" item-name="Position"></menu-dropdown-item>
 * </menu-dropdown-sub>
 * ```
 *
 * **The panel is portalled to `<body>`.** `.dropdown-menu` carries a
 * `backdrop-filter`, which makes the parent menu the containing block for
 * fixed-position descendants *and* clips them to its own scrolling box — so a
 * submenu nested inside it would be positioned against the wrong origin and
 * then cut off at the parent's edge. Living next to the menu rather than
 * inside it also means the parent's `max-height` never applies to it.
 */
@customElement("menu-dropdown-sub")
export class MenuDropdownSub extends LitElement {
  name: string;
  /** A Material Symbols glyph name, or "" for a text-only trigger. */
  icon: string;

  private trigger: HTMLElement | null = null;
  private submenu: HTMLElement | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.name = this.getAttribute("item-name") || "untitle";
    this.icon = this.getAttribute("item-icon") || "";
  }

  template() {
    const icon = this.icon
      ? `<span class="material-symbols-outlined icon-xs">${this.icon}</span>`
      : "";
    return `<li><a class="dropdown-item dropdown-item-sm dropdown-item-icon dropdown-sub-trigger">${icon}<span class="dropdown-sub-label">${this.name}</span><span class="material-symbols-outlined icon-xs dropdown-sub-chevron">chevron_right</span></a></li>`;
  }

  connectedCallback() {
    // Read before the trigger overwrites it, exactly as `MenuDropdownBody`
    // does: the children have not been upgraded yet, so this is still the
    // markup the caller wrote.
    const items = this.innerHTML;
    this.innerHTML = this.template();

    this.trigger = this.querySelector(".dropdown-sub-trigger");

    const submenu = document.createElement("ul");
    submenu.className = "dropdown-menu dropdown-submenu";
    submenu.innerHTML = items;
    document.body.appendChild(submenu);
    this.submenu = submenu;

    this.trigger?.addEventListener("mouseenter", this.onTriggerEnter);
    // A click on the trigger must not reach `document`, where the parent menu's
    // dismissal is listening. Every other row *should* dismiss the menu, which
    // is why this is on the trigger rather than on the whole component.
    this.trigger?.addEventListener("click", this.onTriggerClick);
    this.addEventListener("mouseleave", this.scheduleClose);
    submenu.addEventListener("mouseenter", this.cancelClose);
    submenu.addEventListener("mouseleave", this.scheduleClose);
  }

  disconnectedCallback() {
    this.cancelClose();
    // The panel is not a descendant, so nothing else takes it with us.
    this.submenu?.remove();
    this.submenu = null;
  }

  private readonly onTriggerEnter = () => {
    this.cancelClose();
    this.openSubmenu();
  };

  private readonly onTriggerClick = (event: Event) => {
    event.stopPropagation();
    if (this.submenu?.classList.contains("show")) {
      this.closeSubmenu();
    } else {
      this.openSubmenu();
    }
  };

  private readonly cancelClose = () => {
    if (this.closeTimer != null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  };

  private readonly scheduleClose = () => {
    this.cancelClose();
    this.closeTimer = setTimeout(() => this.closeSubmenu(), SUBMENU_CLOSE_MS);
  };

  openSubmenu() {
    const submenu = this.submenu;
    const trigger = this.trigger;
    if (submenu == null || trigger == null) {
      return;
    }

    // Two submenus open at once would each claim the same strip of window and
    // one would sit on top of the other.
    this.closeSiblings();

    // Shown first, then measured: `display: none` measures 0×0, and a submenu
    // that thinks it is empty fits anywhere.
    submenu.classList.add("show");
    submenu.style.visibility = "hidden";
    applySubmenuPlacement(submenu, trigger);
    submenu.style.visibility = "visible";
    trigger.classList.add("active");
  }

  closeSubmenu() {
    this.cancelClose();
    this.submenu?.classList.remove("show");
    this.trigger?.classList.remove("active");
  }

  private closeSiblings() {
    const root = this.closest("menu-dropdown-body") ?? this.parentElement;
    root?.querySelectorAll("menu-dropdown-sub").forEach((sub) => {
      if (sub !== this) {
        (sub as MenuDropdownSub).closeSubmenu();
      }
    });
  }
}
