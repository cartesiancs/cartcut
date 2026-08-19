import { describe, it, expect } from "vitest";
import { isTypingTarget } from "./typingTarget";

describe("isTypingTarget", () => {
  it("claims the keystroke for text fields", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "input" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "number" })).toBe(true);
  });

  it("claims the keystroke for contenteditable, whatever the tag", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(
      true,
    );
    expect(isTypingTarget({ tagName: "SPAN", isContentEditable: true })).toBe(
      true,
    );
  });

  it("leaves the keystroke to the app everywhere else", () => {
    expect(isTypingTarget({ tagName: "CANVAS" })).toBe(false);
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: false })).toBe(
      false,
    );
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
  });

  it("leaves the keystroke to the app for fields that take no text", () => {
    // A checkbox or a slider does not swallow Backspace, and stealing the
    // shortcut there would make Delete stop working next to any toolbar.
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "color" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "button" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", readOnly: true })).toBe(false);
    expect(isTypingTarget({ tagName: "TEXTAREA", disabled: true })).toBe(false);
  });

  it("survives a missing or exotic target", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
    expect(isTypingTarget({})).toBe(false);
    expect(isTypingTarget("INPUT")).toBe(false);
  });
});

// ============================================================ isTypingEvent

import { isTypingEvent } from "./typingTarget";

describe("isTypingEvent", () => {
  const textInput = { tagName: "INPUT", type: "text" };

  it("sees through a shadow boundary via composedPath", () => {
    // Shadow DOM retargets `event.target` to the *host* as the event crosses
    // the boundary, so a keystroke typed into `number-input`'s inner `<input>`
    // reaches a window listener as `<number-input>` — not a text field by any
    // test. Backspace while correcting a digit deleted the selected clip.
    const event = {
      target: { tagName: "NUMBER-INPUT" },
      composedPath: () => [textInput, { tagName: "NUMBER-INPUT" }, {}],
    };
    expect(isTypingEvent(event)).toBe(true);
  });

  it("still says no for a shadow host with nothing typable inside", () => {
    const event = {
      target: { tagName: "SOME-WIDGET" },
      composedPath: () => [{ tagName: "SPAN" }, { tagName: "SOME-WIDGET" }],
    };
    expect(isTypingEvent(event)).toBe(false);
  });

  it("falls back to the target when composedPath is unavailable", () => {
    expect(isTypingEvent({ target: textInput })).toBe(true);
    expect(isTypingEvent({ target: { tagName: "CANVAS" } })).toBe(false);
  });

  it("falls back to the shadow root's active element", () => {
    // For engines with shadow DOM but no `composedPath`.
    const event = {
      target: { tagName: "NUMBER-INPUT", shadowRoot: { activeElement: textInput } },
    };
    expect(isTypingEvent(event)).toBe(true);
  });

  it("says no for a range input inside a shadow root", () => {
    // A slider takes arrow keys but no text, so the app keeps its shortcuts.
    const event = {
      target: { tagName: "MY-SLIDER" },
      composedPath: () => [{ tagName: "INPUT", type: "range" }],
    };
    expect(isTypingEvent(event)).toBe(false);
  });

  it.each([null, undefined, {}])("survives %s", (event) => {
    expect(isTypingEvent(event as any)).toBe(false);
  });

  it("survives a composedPath that throws nothing but returns junk", () => {
    expect(
      isTypingEvent({ target: null, composedPath: () => [null, undefined, 5] }),
    ).toBe(false);
  });
});
