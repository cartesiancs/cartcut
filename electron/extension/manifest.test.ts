import { describe, expect, it } from "vitest";

import { isKnownActivationEvent, satisfiesEngine, validateManifest } from "./manifest";
import { EXTENSION_API_VERSION } from "./protocol";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "hello",
    publisher: "acme",
    version: "1.0.0",
    main: "main.js",
    engines: { cartcut: "^1" },
    cartcut: { activationEvents: ["onStartup"] },
    ...overrides,
  };
}

function expectOk(json: unknown, dir = "acme.hello") {
  const result = validateManifest(json, dir);
  if (!result.ok) {
    throw new Error("expected a valid manifest, got: " + result.errors.join("; "));
  }
  return result.manifest;
}

function errorsOf(json: unknown, dir = "acme.hello"): string[] {
  const result = validateManifest(json, dir);
  return result.ok ? [] : result.errors;
}

describe("validateManifest", () => {
  it("accepts a minimal manifest and derives the id", () => {
    expect(expectOk(base()).id).toBe("acme.hello");
  });

  it("lowercases the id so one folder cannot serve two origins", () => {
    // A `cartcut-ext://` host is lowercased by the URL parser, so `Acme.Hello`
    // and `acme.hello` would be one origin with two directories.
    expect(expectOk(base({ publisher: "Acme", name: "Hello" })).id).toBe("acme.hello");
  });

  it("refuses a manifest whose id does not match its folder", () => {
    expect(errorsOf(base(), "someone.else").join()).toContain("does not match");
  });

  it("refuses an id with a path separator in it", () => {
    expect(errorsOf(base({ name: "a/b" }), "").length).toBeGreaterThan(0);
  });

  it("refuses a main outside the extension folder", () => {
    expect(errorsOf(base({ main: "../../../etc/passwd" })).join()).toContain("main");
  });

  it("refuses an engine range this build does not satisfy", () => {
    expect(errorsOf(base({ engines: { cartcut: "^2" } })).join()).toContain("engines.cartcut");
  });

  it("refuses a permission the app does not grant", () => {
    const errors = errorsOf(base({ cartcut: { permissions: ["everything"] } }));
    expect(errors.join()).toContain("everything");
  });

  it("refuses an activation event it would never raise", () => {
    const errors = errorsOf(base({ cartcut: { activationEvents: ["onCommnad:typo"] } }));
    expect(errors.join()).toContain("onCommnad:typo");
  });

  it("refuses a duplicate command id", () => {
    const errors = errorsOf(
      base({
        cartcut: {
          contributes: {
            commands: [
              { id: "a", title: "A" },
              { id: "a", title: "A again" },
            ],
          },
        },
      }),
    );
    expect(errors.join()).toContain("declared twice");
  });

  it("refuses a keybinding for a command that does not exist", () => {
    // A binding with nothing behind it swallows the keystroke and does
    // nothing, which is worse than no binding: the app's own handler has
    // already declined it by then.
    const errors = errorsOf(
      base({
        cartcut: {
          contributes: {
            commands: [{ id: "a", title: "A" }],
            keybindings: [{ command: "missing", key: "mod+k" }],
          },
        },
      }),
    );
    expect(errors.join()).toContain("missing");
  });

  it("refuses a menu item for a command that does not exist", () => {
    const errors = errorsOf(
      base({
        cartcut: {
          contributes: {
            commands: [{ id: "a", title: "A" }],
            menus: { "app/extensions": [{ command: "nope" }] },
          },
        },
      }),
    );
    expect(errors.join()).toContain("nope");
  });

  it("refuses a view page that escapes the folder", () => {
    const errors = errorsOf(
      base({
        cartcut: {
          contributes: {
            views: [{ id: "v", kind: "sidebar", title: "V", page: "../outside.html" }],
          },
        },
      }),
    );
    expect(errors.join()).toContain("page");
  });

  it("refuses tools without the ai.tools permission", () => {
    const errors = errorsOf(
      base({
        cartcut: {
          contributes: {
            tools: [{ name: "do_thing", description: "Does a thing." }],
          },
        },
      }),
    );
    expect(errors.join()).toContain("ai.tools");
  });

  it("refuses an unknown key in the cartcut section", () => {
    // Strict rather than permissive: a typo in `contribues` would otherwise
    // install cleanly and contribute nothing, with no error anywhere.
    const errors = errorsOf(base({ cartcut: { contribues: {} } }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("collects every error rather than stopping at the first", () => {
    const errors = errorsOf(base({ version: "nope", engines: { cartcut: "^9" } }));
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("satisfiesEngine", () => {
  const cases: Array<[string, boolean]> = [
    ["^1", true],
    ["^1.0", true],
    ["^1.0.0", true],
    ["1.x", true],
    ["*", true],
    [">=1.0.0", true],
    ["^2", false],
    ["^1.5.0", false],
    [">=2.0.0", false],
    ["2.x", false],
    ["latest", false],
    ["~1.0.0", false],
  ];

  for (const [range, expected] of cases) {
    it((expected ? "satisfies " : "refuses ") + range, () => {
      expect(satisfiesEngine(range, EXTENSION_API_VERSION)).toBe(expected);
    });
  }

  it("refuses a range it cannot parse rather than assuming compatibility", () => {
    expect(satisfiesEngine("whatever the author meant")).toBe(false);
  });
});

describe("isKnownActivationEvent", () => {
  it("knows the five shapes", () => {
    for (const event of ["*", "onStartup", "onProjectOpen", "onCommand:a.b", "onView:panel", "onFiletype:mp4"]) {
      expect([event, isKnownActivationEvent(event)]).toEqual([event, true]);
    }
  });

  it("refuses anything else", () => {
    for (const event of ["onOpen", "onCommand:", "onFiletype:MP4", "onCommand:a b"]) {
      expect([event, isKnownActivationEvent(event)]).toEqual([event, false]);
    }
  });
});
