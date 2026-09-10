import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
  modifiersOf,
  nudgeValue,
  roundTo,
  type ScrubOptions,
} from "../../features/input/numberScrub";
import {
  isScrubStart,
  startScrub,
  windowScrubHost,
  type ScrubSession,
} from "../../features/input/scrubSession";

/** Two decimal places, and the float artefact that comes with them removed. */
const round2 = (n: number) => roundTo(n, 2);

@customElement("number-input")
export class NumberInput extends LitElement {
  /**
   * The number this field holds — and, while a drag is running, the one thing
   * that may write it.
   *
   * The accessor is hand-written for that second half. Every consumer answers
   * this component's `onChange` by writing the store, and the store's
   * subscribers write the value straight back onto this element: in
   * `controlDefaultTransform` that happens *synchronously inside*
   * `dispatchEvent`, and in `optionMaskSection` it arrives as a re-render a
   * microtask later. That write-back is not noise — it is how a value the pure
   * op clamped gets back onto the screen — but accepting it mid-gesture makes
   * the number oscillate between what the drag says and what the store says.
   *
   * So the scrub owns the field for the length of the gesture, and the guard
   * lifts the moment it ends. The resync then happens on its own, and the
   * ordering that makes it work is not an accident: this component's `mouseup`
   * listener is registered at mousedown and `GestureCommit`'s at the first
   * mousemove, so on release the session ends first, the checkpoint lands
   * second, and the store's notification finds the guard already down.
   *
   * The value has to live on the property rather than in a display-only field
   * because consumers read it back with `parseFloat(dom.value)`.
   */
  @property({ type: Number, noAccessor: true })
  get value(): number {
    return this._value;
  }
  set value(next: number) {
    if (this._scrub != null) {
      return;
    }
    this._setValue(next);
  }

  /**
   * The range and the grid, both optional.
   *
   * Declaring them is what keeps the drag agreeing with the op behind it: the
   * accumulator stops where the op would clamp, so the number never shows a
   * value the store is about to overrule.
   */
  @property({ type: Number }) min?: number;
  @property({ type: Number }) max?: number;
  @property({ type: Number }) step = 0.1;
  /** Value units per pixel of drag. The default reproduces the original feel. */
  @property({ type: Number }) sensitivity = 0.3;

  private _value = 0;
  private _scrub: ScrubSession | null = null;

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
  /** The number the box opened on, so Escape has something to go back to. */
  private _editStart = 0;

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
      cursor: text;
    }
  `;

  disconnectedCallback() {
    // A field re-rendered away mid-drag used to leave its `window` listeners
    // behind, still moving a value nothing was showing.
    this._scrub?.cancel();
    this._scrub = null;
    super.disconnectedCallback();
  }

  render() {
    if (this.editing) {
      return html`
        <input
          type="text"
          inputmode="decimal"
          .value="${this._editText}"
          @input="${this._onInput}"
          @blur="${this._onBlur}"
          @keydown="${this._onEditKeyDown}"
        />
      `;
    }
    return html`
      <span class="number-display" @mousedown="${this._onMouseDown}">
        ${round2(this.value).toFixed(2)}
      </span>
    `;
  }

  /** The drag's arithmetic, as this field declares it. */
  private get scrubOptions(): ScrubOptions {
    return {
      sensitivity: this.sensitivity,
      step: this.step,
      min: this.min,
      max: this.max,
      decimals: 2,
    };
  }

  private _clamp(value: number): number {
    let next = value;
    if (this.min != null && next < this.min) next = this.min;
    if (this.max != null && next > this.max) next = this.max;
    return next;
  }

  /** Write past the scrub guard. Only the gesture and the text box come here. */
  private _setValue(next: number) {
    const value = Number.isFinite(next) ? next : 0;
    const old = this._value;
    if (Object.is(old, value)) {
      return;
    }
    this._value = value;
    this.requestUpdate("value", old);
  }

  private _onMouseDown(event: MouseEvent) {
    if (!isScrubStart(event) || this._scrub != null) {
      return;
    }
    this._scrub = startScrub(
      this.value,
      this.scrubOptions,
      {
        onDragStart: () => {
          this.editing = false;
        },
        onValue: (value) => {
          this._setValue(value);
          this._dispatchOnChange();
        },
        onEnd: ({ dragged, cancelled }) => {
          // Cleared before the consumer hears anything, so the write-back that
          // follows is allowed through.
          this._scrub = null;
          if (cancelled) {
            this._dispatchOnCancel();
            return;
          }
          // A press that never became a drag is a click, and a click opens the
          // editor. Read from the gesture rather than from a `click` listener:
          // the pointer lock is taken on mousedown, so by the time the button
          // comes up the events are going to `document.body` and no `click`
          // reaches this span at all.
          if (!dragged) {
            this._openEditor();
          }
        },
      },
      windowScrubHost(),
    );
  }

  private _openEditor() {
    // Seeded from the rounded number, and with the trailing zeros dropped:
    // the box is about to be typed into, so "250" is a better starting point
    // than "250.00" and a far better one than "249.99999999999997".
    this._editStart = this.value;
    this._editText = String(round2(this.value));
    this.editing = true;
    this.updateComplete.then(() => {
      const inputEl = this.shadowRoot?.querySelector("input");
      if (inputEl == null) {
        return;
      }
      inputEl.focus();
      // The caret goes to the front, not to the end of the decimals. This is
      // the one reason the box is `type="text"`: a number input throws
      // `InvalidStateError` from `setSelectionRange`.
      inputEl.setSelectionRange(0, 0);
    });
  }

  private _onInput(e: Event) {
    const input = e.target as HTMLInputElement;
    // The text is left exactly as typed — rounding it here would move the
    // caret mid-number — while the value that leaves the component is rounded
    // and clamped, so nothing downstream ever receives more precision, or more
    // range, than the field declares.
    this._editText = input.value;
    const parsed = parseFloat(input.value);
    this._setValue(this._clamp(round2(Number.isFinite(parsed) ? parsed : 0)));
    this._dispatchOnChange();
  }

  /**
   * The arrow keys, reimplemented.
   *
   * A `type="text"` box has no native stepping, and the native one would not
   * have known about `step` or about the drag's modifiers anyway. Same grid and
   * same multipliers as the scrub, from the same module.
   */
  private _onEditKeyDown(event: KeyboardEvent) {
    const input = event.target as HTMLInputElement;

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = nudgeValue(
        this.value,
        event.key === "ArrowUp" ? 1 : -1,
        modifiersOf(event),
        this.scrubOptions,
      );
      this._setValue(next);
      this._editText = String(next);
      this._dispatchOnChange();
      return;
    }

    if (event.key === "Enter") {
      input.blur();
      return;
    }

    if (event.key === "Escape") {
      // Stopped here so the timeline does not also read it as "cancel my
      // gesture" — the caret is in a field, and the key means this field.
      event.stopPropagation();
      event.preventDefault();
      this._setValue(this._editStart);
      this._editText = String(round2(this._editStart));
      this._dispatchOnChange();
      input.blur();
    }
  }

  private _onBlur() {
    this.editing = false;
  }

  private _dispatchOnChange() {
    this.dispatchEvent(
      new CustomEvent("onChange", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * The drag was abandoned — Escape, or the field going away under it.
   *
   * Deliberately carries no value. Re-emitting the number the drag started on
   * would look like an edit back to it, and an edit is what `GestureCommit`
   * would then record: `withCheckpoint` cannot decline a document it did not
   * build, so the user would get an undo step for nothing — and, on an animated
   * property, would keep the keyframe the drag's first move created at the
   * playhead. Consumers answer this with `GestureCommit.cancel()`, which puts
   * the whole pre-gesture document back and records nothing.
   */
  private _dispatchOnCancel() {
    this.dispatchEvent(
      new CustomEvent("onCancel", { bubbles: true, composed: true }),
    );
  }
}
