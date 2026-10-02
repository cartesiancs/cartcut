import { describe, it, expect } from "vitest";
import {
  installNativeContextMenuGuard,
  type ContextMenuEventLike,
  type ContextMenuTarget,
} from "./nativeContextMenu";

/** A `window` that records what was installed on it. */
function fakeWindow() {
  const installed: {
    listener: (event: ContextMenuEventLike) => void;
    options: { capture: true };
  }[] = [];
  const target: ContextMenuTarget = {
    addEventListener: (_type, listener, options) => {
      installed.push({ listener, options });
    },
  };
  return { target, installed };
}

/** Right-click `target`, and report whether the native menu was cancelled. */
function rightClick(
  installed: ReturnType<typeof fakeWindow>["installed"],
  target: unknown,
): boolean {
  let cancelled = false;
  const event: ContextMenuEventLike = {
    target,
    composedPath: () => [target],
    preventDefault: () => {
      cancelled = true;
    },
  };
  for (const { listener } of installed) {
    listener(event);
  }
  return cancelled;
}

describe("installNativeContextMenuGuard", () => {
  it("installs nothing in Electron, which shows no native menu of its own", () => {
    const { target, installed } = fakeWindow();

    installNativeContextMenuGuard("electron", target);

    expect(installed).toHaveLength(0);
  });

  it("cancels the browser's menu over the preview and the timeline", () => {
    for (const env of ["web", "demo"] as const) {
      const { target, installed } = fakeWindow();

      installNativeContextMenuGuard(env, target);

      // "Save image as" is what the browser offers over a canvas.
      expect(rightClick(installed, { tagName: "CANVAS" })).toBe(true);
      expect(rightClick(installed, { tagName: "DIV" })).toBe(true);
    }
  });

  it("leaves the browser's menu on a text field, for copy and paste", () => {
    const { target, installed } = fakeWindow();

    installNativeContextMenuGuard("demo", target);

    expect(rightClick(installed, { tagName: "TEXTAREA" })).toBe(false);
    expect(rightClick(installed, { tagName: "INPUT", type: "text" })).toBe(false);
    expect(rightClick(installed, { tagName: "DIV", isContentEditable: true })).toBe(
      false,
    );
    // Not a text field, so the guard applies.
    expect(rightClick(installed, { tagName: "INPUT", type: "range" })).toBe(true);
  });

  it("listens in the capture phase, so a stopped event cannot slip past", () => {
    const { target, installed } = fakeWindow();

    installNativeContextMenuGuard("web", target);

    expect(installed[0].options).toEqual({ capture: true });
  });
});
