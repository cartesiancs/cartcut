/**
 * The check whose absence broke both halves of drag-and-drop at once.
 *
 * The curtain rose on every drag because nothing here existed to consult, and
 * the timeline canvas refused OS files for the same reason.
 */

import { describe, it, expect } from "vitest";
import { ASSET_MIME, FILES_MIME, dropIntent } from "./dropIntent";

describe("dropIntent", () => {
  it("reads a drag from outside the window as OS files", () => {
    expect(dropIntent([FILES_MIME])).toBe("os-files");
  });

  it("reads a drag out of the asset panel as an asset", () => {
    expect(dropIntent([ASSET_MIME])).toBe("asset");
  });

  it("calls a drag carrying both types an asset", () => {
    // The regression this whole module exists for. Chromium can list "Files"
    // alongside a custom type on a drag that started inside the app; reading
    // "Files" first sends it down the OS import path, where `dataTransfer.files`
    // is empty and the drop silently does nothing.
    expect(dropIntent([FILES_MIME, ASSET_MIME])).toBe("asset");
    expect(dropIntent([ASSET_MIME, FILES_MIME])).toBe("asset");
  });

  it("ignores a drag the editor has no use for", () => {
    expect(dropIntent(["text/plain"])).toBe("ignore");
    expect(dropIntent(["text/uri-list", "text/html"])).toBe("ignore");
  });

  it("ignores a drag carrying nothing", () => {
    expect(dropIntent([])).toBe("ignore");
  });

  it("survives a DragEvent with no dataTransfer at all", () => {
    // `e.dataTransfer?.types` is `undefined` there, and every caller passes it
    // straight through rather than guarding first.
    expect(dropIntent(undefined)).toBe("ignore");
  });

  it("matches the type the asset panel actually writes", () => {
    // Pinned as a literal: `assetList.ts` and the canvas agree only because
    // they import this constant, and a rename that missed one would be silent.
    expect(ASSET_MIME).toBe("application/x-cartcut-asset");
    expect(FILES_MIME).toBe("Files");
  });
});
