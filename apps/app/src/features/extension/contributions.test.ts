import { beforeEach, describe, expect, it } from "vitest";

import {
  contributionStore,
  flattenContributions,
  inspectorViews,
  panelViews,
  sidebarViews,
} from "./contributions";
import type { HelloExtension } from "./shared";

function hello(overrides: Partial<HelloExtension> = {}): HelloExtension {
  return {
    id: "acme.hello",
    version: "1.0.0",
    displayName: "Hello",
    permissions: ["timeline.write"],
    contributes: {
      commands: [{ id: "hello.say", title: "Hello: Say" }],
      keybindings: [{ command: "hello.say", key: "mod+alt+h" }],
      views: [
        { id: "panel", kind: "sidebar", title: "Hello", page: "views/panel.html" },
        { id: "dock", kind: "panel", title: "Docked", page: "views/dock.html" },
        { id: "insp", kind: "inspector", title: "Info", page: "views/i.html", elementTypes: ["video"] },
      ],
      menus: { "app/extensions": [{ command: "hello.say" }] },
    },
    ...overrides,
  } as HelloExtension;
}

describe("flattenContributions", () => {
  it("namespaces every key by extension", () => {
    // Two extensions each contributing `panel` must be two views, not a clash.
    const flat = flattenContributions([hello(), hello({ id: "other.ext", displayName: "Other" })]);
    expect(flat.views.map((view) => view.key)).toContain("acme.hello/panel");
    expect(flat.views.map((view) => view.key)).toContain("other.ext/panel");
    expect(new Set(flat.views.map((view) => view.key)).size).toBe(flat.views.length);
  });

  it("gives a menu item the title of the command it names", () => {
    expect(flattenContributions([hello()]).menus[0].title).toBe("Hello: Say");
  });

  it("survives a contribution block with nothing in it", () => {
    // It runs before anything is drawn, on a message from another process. A
    // throw here would take the editor's first paint with it.
    expect(() => flattenContributions([hello({ contributes: {} as never })])).not.toThrow();
    expect(() => flattenContributions([{ id: "a.b" } as never])).not.toThrow();
  });

  it("drops an entry with no id rather than keying on undefined", () => {
    const flat = flattenContributions([
      hello({ contributes: { views: [{ kind: "sidebar", title: "x", page: "p.html" }] } as never }),
    ]);
    expect(flat.views).toHaveLength(0);
  });
});

describe("contributionStore", () => {
  beforeEach(() => {
    contributionStore.getState().clear();
  });

  it("returns the same state when a hello says nothing new", () => {
    // The host re-sends its whole hello on every restart, and a developer
    // saving an unpacked extension restarts it on every burst of keystrokes.
    contributionStore.getState().applyHello([hello()]);
    const first = contributionStore.getState();
    contributionStore.getState().applyHello([hello()]);
    expect(contributionStore.getState()).toBe(first);
  });

  it("drops one extension's contributions and keeps the rest", () => {
    contributionStore.getState().applyHello([hello(), hello({ id: "other.ext" })]);
    contributionStore.getState().removeExtension("acme.hello");
    const state = contributionStore.getState();
    expect(state.extensions.map((entry) => entry.id)).toEqual(["other.ext"]);
    expect(state.views.every((view) => view.extId === "other.ext")).toBe(true);
    expect(state.commands.every((command) => command.extId === "other.ext")).toBe(true);
  });

  it("declines a removal of something it does not have", () => {
    contributionStore.getState().applyHello([hello()]);
    const before = contributionStore.getState();
    contributionStore.getState().removeExtension("nobody.here");
    expect(contributionStore.getState()).toBe(before);
  });

  it("keeps a status item only while its extension is loaded", () => {
    contributionStore.getState().applyHello([hello()]);
    contributionStore.getState().setStatusItem({
      key: "acme.hello/s",
      extId: "acme.hello",
      itemId: "s",
      alignment: "right",
      priority: 0,
      text: "Hi",
      tooltip: null,
      commandId: null,
    });
    expect(contributionStore.getState().statusItems).toHaveLength(1);

    contributionStore.getState().applyHello([hello({ id: "other.ext" })]);
    expect(contributionStore.getState().statusItems).toHaveLength(0);
  });

  it("replaces a status item rather than stacking duplicates", () => {
    const item = {
      key: "acme.hello/s",
      extId: "acme.hello",
      itemId: "s",
      alignment: "right" as const,
      priority: 0,
      tooltip: null,
      commandId: null,
    };
    contributionStore.getState().setStatusItem({ ...item, text: "one" });
    contributionStore.getState().setStatusItem({ ...item, text: "two" });
    expect(contributionStore.getState().statusItems.map((entry) => entry.text)).toEqual(["two"]);
  });

  it("clears to empty", () => {
    contributionStore.getState().applyHello([hello()]);
    contributionStore.getState().clear();
    expect(contributionStore.getState().views).toHaveLength(0);
    expect(contributionStore.getState().extensions).toHaveLength(0);
  });
});

describe("view selectors", () => {
  beforeEach(() => {
    contributionStore.getState().clear();
    contributionStore.getState().applyHello([hello()]);
  });

  it("splits views by where they are mounted", () => {
    const state = contributionStore.getState();
    expect(sidebarViews(state).map((view) => view.viewId)).toEqual(["panel"]);
    expect(panelViews(state).map((view) => view.viewId)).toEqual(["dock"]);
  });

  it("shows an inspector section only for the types it declares", () => {
    const state = contributionStore.getState();
    expect(inspectorViews(state, "video")).toHaveLength(1);
    expect(inspectorViews(state, "text")).toHaveLength(0);
    expect(inspectorViews(state, null)).toHaveLength(0);
  });
});
