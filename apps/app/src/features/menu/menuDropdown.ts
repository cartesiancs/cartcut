import { LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { applyMenuPlacement } from "./menuPlacement";

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
  }

  disconnectedCallback() {
    document.removeEventListener("click", this.onDocumentClick);
  }
}

@customElement("menu-dropdown-item")
export class MenuDropdownItem extends LitElement {
  name: string;
  constructor() {
    super();

    this.name = this.getAttribute("item-name") || "untitle";
  }

  render() {
    const template = this.template();
    this.innerHTML = template;
  }

  template() {
    return `<li><a class="dropdown-item dropdown-item-sm">${this.name}</a></li>`;
  }

  connectedCallback() {
    this.render();
  }
}
