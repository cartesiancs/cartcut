import { describe, expect, it } from "vitest";
import { templateNameFrom } from "./templateExport";

/**
 * Where a template's name comes from.
 *
 * **There is no name prompt, and there must not be one.** `window.prompt`
 * throws outright in Electron — "prompt() is and will not be supported" — and
 * asking twice would be wrong even where it works: the save dialog already
 * makes the user type a name, and a template called something other than its
 * own filename is one nobody can find again.
 */
describe("templateNameFrom", () => {
  it("is the filename the user chose, without the extension", () => {
    expect(templateNameFrom("/Users/me/Desktop/Neon Intro.cttpl")).toBe(
      "Neon Intro",
    );
  });

  it("keeps the case and the spaces the user typed", () => {
    // Unlike the *install* id, which is lower-cased and dashed because it
    // becomes a path segment. This one is only ever shown.
    expect(templateNameFrom("/x/My Big Intro.cttpl")).toBe("My Big Intro");
  });

  it("strips the extension case-insensitively", () => {
    expect(templateNameFrom("/x/Neon.CTTPL")).toBe("Neon");
  });

  it("handles a Windows path", () => {
    expect(templateNameFrom("C:\\Users\\me\\Neon.cttpl")).toBe("Neon");
  });

  it("leaves a name that has no extension alone", () => {
    expect(templateNameFrom("/x/Neon")).toBe("Neon");
  });

  it("keeps a dot that is not the extension", () => {
    expect(templateNameFrom("/x/v1.2 final.cttpl")).toBe("v1.2 final");
  });

  it("never answers empty", () => {
    expect(templateNameFrom("/x/.cttpl")).toBe("Template");
    expect(templateNameFrom("")).toBe("Template");
    expect(templateNameFrom("/x/   .cttpl")).toBe("Template");
  });

  it("keeps a non-latin name", () => {
    expect(templateNameFrom("/x/네온 인트로.cttpl")).toBe("네온 인트로");
  });
});
