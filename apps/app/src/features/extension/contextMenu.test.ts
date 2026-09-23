import { describe, expect, it } from "vitest";

import {
  CLIP_MENU_LOCATION,
  MAX_ITEM_LABEL,
  clipMenuItems,
  extensionMenuHtml,
} from "./contextMenu";
import type { ContributedMenuItem, IContributionStore } from "./contributions";

const item = (overrides: Partial<ContributedMenuItem> = {}): ContributedMenuItem => ({
  extId: "acme.hello",
  commandId: "hello.tag",
  title: "Tag this clip",
  when: null,
  location: CLIP_MENU_LOCATION,
  ...overrides,
});

const stateWith = (menus: ContributedMenuItem[]) => ({ menus }) as unknown as IContributionStore;

const anySelection = { selectionCount: 1, selectionTypes: ["video"] };

describe("clipMenuItems", () => {
  it("takes only the clip menu", () => {
    const state = stateWith([item(), item({ location: "app/extensions" })]);
    expect(clipMenuItems(state, anySelection)).toHaveLength(1);
  });

  it("honours a when clause", () => {
    const state = stateWith([item({ when: "selection.type == audio" })]);
    expect(clipMenuItems(state, anySelection)).toHaveLength(0);
    expect(clipMenuItems(state, { selectionCount: 1, selectionTypes: ["audio"] })).toHaveLength(1);
  });

  it("orders by extension then title, so rows do not shuffle", () => {
    // Two openings of the same menu must list the same rows in the same
    // places, whatever order the extensions happened to activate in.
    const state = stateWith([
      item({ extId: "b.two", title: "Zeta" }),
      item({ extId: "a.one", title: "Beta" }),
      item({ extId: "a.one", title: "Alpha" }),
    ]);
    expect(clipMenuItems(state, anySelection).map((entry) => entry.title)).toEqual([
      "Alpha",
      "Beta",
      "Zeta",
    ]);
  });
});

describe("extensionMenuHtml", () => {
  it("is empty when there is nothing, so a machine with no extensions sees no change", () => {
    expect(extensionMenuHtml([])).toBe("");
  });

  it("builds a row that calls back through the DOM", () => {
    const html = extensionMenuHtml([item()]);
    expect(html).toContain("runExtensionMenuItem('acme.hello', 'hello.tag')");
    expect(html).toContain('item-name="Tag this clip"');
  });

  it("escapes a title that would break out of its attribute", () => {
    const html = extensionMenuHtml([
      item({ title: '"><img src=x onerror=alert(1)>' }),
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("escapes markup in a title without dropping the row", () => {
    const html = extensionMenuHtml([item({ title: "a & b <c>" })]);
    expect(html).toContain("a &amp; b &lt;c&gt;");
  });

  it("drops a row whose ids do not match their patterns", () => {
    // Escaping cannot help inside the single-quoted JavaScript string in the
    // `onclick`, and the ids are the only thing that goes there. Main
    // validates them, but they reach the renderer from another process.
    const hostile = [
      item({ extId: "acme.hello'); alert(1); //" }),
      item({ commandId: "x'); alert(1); //" }),
      item({ extId: "Acme.Hello" }),
      item({ extId: "" }),
      item({ commandId: "" }),
    ];
    for (const entry of hostile) {
      expect([entry.extId, entry.commandId, extensionMenuHtml([entry])]).toEqual([
        entry.extId,
        entry.commandId,
        "",
      ]);
    }
  });

  it("keeps the good rows when one is dropped", () => {
    const html = extensionMenuHtml([item({ extId: "bad id" }), item({ title: "Fine" })]);
    expect(html).toContain('item-name="Fine"');
    expect(html.match(/menu-dropdown-item/g)).toHaveLength(2);
  });

  it("flattens and caps a label rather than letting it break the row", () => {
    const html = extensionMenuHtml([item({ title: "one\ntwo\tthree" })]);
    expect(html).toContain('item-name="one two three"');

    const long = extensionMenuHtml([item({ title: "x".repeat(MAX_ITEM_LABEL + 40) })]);
    const label = /item-name="([^"]*)"/.exec(long)?.[1] ?? "";
    expect(label.length).toBe(MAX_ITEM_LABEL);
  });

  it("drops a row whose title is only whitespace", () => {
    expect(extensionMenuHtml([item({ title: "   " })])).toBe("");
  });
});
