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
