import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

/** Two decimal places, and the float artefact that comes with them removed. */
const round2 = (n: number) => Math.round(n * 100) / 100;

@customElement("number-input")
export class NumberInput extends LitElement {
  @property({ type: Number, reflect: true })
  value = 0;

  @state() private editing = false;
  /**
   * What the text box holds while it is open.
   *
   * Kept apart from `value` so the field is not rewritten under the caret on
   * every keystroke — and so opening it starts from the *rounded* number.
   * Binding `String(this.value)` showed the whole float, which is where the
   * fifteen digits came from: a preview drag writes `location` in canvas
   * pixels divided by the zoom, and an animated clip's box is a baked sample.
   */
  @state() private _editText = "";
  @state() private _startValue = 0;
  @state() private _startX = 0;
  @state() private _wasDragging = false;

  static styles = css`
    .number-display {
      border-bottom: 1px solid #2277e7;
      color: #2277e7;
      cursor: ew-resize;
      display: inline-block;
      user-select: none;
    }
    input {
      font-size: inherit;
      width: 60px;
      background-color: #0f1012;
      border: none;
      outline: none;
      color: #2277e7;
    }
  `;

  render() {
    if (this.editing) {
      return html`
        <input
          type="number"
          .value="${this._editText}"
          @input="${this._onInput}"
          @blur="${this._onBlur}"
        />
      `;
    }
    return html`
      <span
        class="number-display"
        @mousedown="${this._onMouseDown}"
        @click="${this._onClick}"
      >
        ${round2(this.value).toFixed(2)}
      </span>
    `;
  }

  private _onInput(e: Event) {
    const input = e.target as HTMLInputElement;
    // The text is left exactly as typed — rounding it here would move the
    // caret mid-number — while the value that leaves the component is rounded,
    // so nothing downstream ever receives more precision than was shown.
    this._editText = input.value;
    const newValue = parseFloat(input.value) || 0;
    this.value = round2(newValue);
    this._dispatchOnChange();
  }

  private _onBlur() {
    this.editing = false;
  }

  private _onMouseDown(e: MouseEvent) {
    this._startX = e.clientX;
    this._startValue = this.value;
    this._wasDragging = false;
    window.addEventListener(
      "mousemove",
      (this._onMouseMoveBound = this._onMouseMove.bind(this)),
    );
    window.addEventListener(
      "mouseup",
      (this._onMouseUpBound = this._onMouseUp.bind(this)),
    );
  }

  private _onMouseMove(e: MouseEvent) {
    const deltaX = e.clientX - this._startX;
    if (!this._wasDragging && Math.abs(deltaX) > 5) {
      this._wasDragging = true;
      this.editing = false;
    }
    if (this._wasDragging) {
      const sensitivity = 0.3;
      let newValue = this._startValue + deltaX * sensitivity;
      newValue = round2(Math.round(newValue * 10) / 10);
      this.value = newValue;
      this._dispatchOnChange();
    }
  }

  private _onMouseUp(_e: MouseEvent) {
    window.removeEventListener("mousemove", this._onMouseMoveBound);
    window.removeEventListener("mouseup", this._onMouseUpBound);
  }

  private _onClick(_e: MouseEvent) {
    if (this._wasDragging) {
      this._wasDragging = false;
      return;
    }
    // Seeded from the rounded number, and with the trailing zeros dropped:
    // the box is about to be typed into, so "250" is a better starting point
    // than "250.00" and a far better one than "249.99999999999997".
    this._editText = String(round2(this.value));
    this.editing = true;
    this.updateComplete.then(() => {
      const inputEl = this.shadowRoot?.querySelector("input");
      if (inputEl) inputEl.focus();
    });
  }

  private _onMouseMoveBound!: any;
  private _onMouseUpBound!: any;

  private _dispatchOnChange() {
    this.dispatchEvent(
      new CustomEvent("onChange", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
