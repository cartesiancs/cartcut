import { describe, expect, it } from "vitest";
import { cssFamilyOf, fontEntryFor, fontValueOfPath } from "./fontParams";

const bundled = (file: string) => (file === "Anton-Regular.ttf" ? "/app/fonts/Anton-Regular.ttf" : null);

describe("fontEntryFor", () => {
  it("resolves the three forms", () => {
    expect(fontEntryFor("default", bundled).name).toBe("notosanskr");
    expect(fontEntryFor("bundled:Anton-Regular.ttf", bundled)).toEqual({
      path: "/app/fonts/Anton-Regular.ttf",
      name: "Anton-Regular",
      type: "ttf",
    });
    expect(fontEntryFor("/Users/me/Brand.otf", bundled).name).toBe("Brand");
    expect(fontEntryFor("C:\\Fonts\\Brand.ttf", bundled).name).toBe("Brand");
  });

  it("falls back to the default face for anything it cannot place", () => {
    expect(fontEntryFor("bundled:Missing.ttf", bundled).name).toBe("notosanskr");
    expect(fontEntryFor("Comic Sans", bundled).name).toBe("notosanskr");
    expect(fontEntryFor(7, bundled).name).toBe("notosanskr");
  });
});

describe("cssFamilyOf", () => {
  it("quotes the name and keeps a Hangul-capable fallback behind it", () => {
    expect(cssFamilyOf({ path: "/x/a.ttf", name: 'Bad"Name', type: "ttf" })).toBe(
      '"Bad\\"Name", "notosanskr", sans-serif',
    );
  });
});

describe("fontValueOfPath", () => {
  const bundled = [{ path: "/app/assets/fonts/google/Anton-Regular.ttf", name: "Anton-Regular", type: "ttf" }];

  it("names a bundled face by its file", () => {
    expect(fontValueOfPath("/app/assets/fonts/google/Anton-Regular.ttf", bundled)).toBe(
      "bundled:Anton-Regular.ttf",
    );
  });

  it("keeps any other path, and maps the default", () => {
    expect(fontValueOfPath("/Library/Fonts/X.otf", bundled)).toBe("/Library/Fonts/X.otf");
    expect(fontValueOfPath("default", bundled)).toBe("default");
    expect(fontValueOfPath("", bundled)).toBe("default");
  });

  it("round-trips through fontEntryFor", () => {
    const value = fontValueOfPath(bundled[0].path, bundled);
    expect(fontEntryFor(value, (file) => (file === "Anton-Regular.ttf" ? bundled[0].path : null)).path).toBe(
      bundled[0].path,
    );
  });
});
