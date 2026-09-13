import { describe, expect, it } from "vitest";
import {
  autosaveSubmenu,
  entryLabel,
  shouldRebuild,
  signatureOf,
  type AutosaveMenuRing,
} from "./autosaveMenu";

/**
 * Mirrors `recordTrayMenu.test.ts`, and asserts the same three invariants it
 * does: the empty state is a disabled row, a click reports exactly what the
 * caller named, and nothing about the structure depends on Electron being
 * loadable.
 *
 * The one genuinely dangerous thing a recovery menu can do is offer a row that
 * recovers something other than what it says. So the load-bearing cases are
 * the ones about *ordering* and about the `(key, file)` pair surviving intact.
 */

const T0 = Date.UTC(2026, 8, 13, 14, 25, 30, 0);
const MIN = 60_000;
const DAY = 24 * 60 * 60 * 1000;

function ring(over: Partial<AutosaveMenuRing> = {}): AutosaveMenuRing {
  return {
    key: "f-abc-Film",
    label: "Film.ngt",
    entries: [{ file: "/cache/f-abc-Film/a.ngt", writtenAtMs: T0 }],
    ...over,
  };
}

/** Electron's template type is structural; these read it back as plain data. */
const subOf = (item: any) => item.submenu as any[];

describe("entryLabel", () => {
  it("says Today for an instant on the same local day", () => {
    expect(entryLabel(T0, T0 + MIN, 0)).toBe("Today 14:25:30");
  });

  it("says Yesterday for the day before", () => {
    expect(entryLabel(T0 - DAY, T0, 0)).toBe("Yesterday 14:25:30");
  });

  it("names the date beyond that", () => {
    expect(entryLabel(T0 - 7 * DAY, T0, 0)).toBe("6 Sep 14:25:30");
  });

  it("includes seconds", () => {
    // At a five-second cadence two entries in one minute is possible, and two
    // rows that cannot be told apart are worse than no rows.
    expect(entryLabel(T0 + 7_000, T0 + MIN, 0)).toBe("Today 14:25:37");
  });

  it("zero-pads", () => {
    expect(entryLabel(Date.UTC(2026, 8, 13, 9, 5, 3), T0, 0)).toBe(
      "Today 09:05:03",
    );
  });

  // The timezone is an explicit parameter precisely so both sides of UTC are
  // covered on one CI host — the rule `assetPaths.ts` states for path flavour.
  it("reads the clock in the given zone, east of UTC", () => {
    // 14:25 UTC is 23:25 in +09:00.
    expect(entryLabel(T0, T0, 540)).toBe("Today 23:25:30");
  });

  it("reads the clock in the given zone, west of UTC", () => {
    // 14:25 UTC is 07:25 in -07:00.
    expect(entryLabel(T0, T0, -420)).toBe("Today 07:25:30");
  });

  it("crosses local midnight east of UTC", () => {
    // LOAD-BEARING for correctness of the *word*: 16:00 UTC is 01:00 the next
    // day in +09:00, so an entry written at 15:00 UTC is "Yesterday" for a
    // viewer in Seoul even though both instants share a UTC day.
    const wrote = Date.UTC(2026, 8, 13, 15, 0, 0);
    const now = Date.UTC(2026, 8, 14, 1, 0, 0);
    expect(entryLabel(wrote, now, 540)).toBe("Today 00:00:00");
    expect(entryLabel(wrote - DAY, now, 540)).toBe("Yesterday 00:00:00");
  });

  it("crosses local midnight west of UTC", () => {
    // 02:00 UTC is 19:00 the previous day in -07:00.
    const wrote = Date.UTC(2026, 8, 14, 2, 0, 0);
    const now = Date.UTC(2026, 8, 14, 3, 0, 0);
    expect(entryLabel(wrote, now, -420)).toBe("Today 19:00:00");
  });
});

describe("autosaveSubmenu", () => {
  it("is a disabled row with a tooltip when nothing is cached", () => {
    // The `recordTrayMenu.ts` rule: never an empty flyout.
    const item = autosaveSubmenu([], () => {}, T0, 0) as any;
    expect(item.label).toBe("Auto Save");
    expect(item.enabled).toBe(false);
    expect(item.submenu).toBeUndefined();
    expect(typeof item.toolTip).toBe("string");
    expect(item.toolTip.length).toBeGreaterThan(0);
  });

  it("says an empty list means everything is saved", () => {
    // The invariant the feature rests on, stated where the user meets it.
    const item = autosaveSubmenu([], () => {}, T0, 0) as any;
    expect(item.toolTip).toContain("everything is saved");
  });

  it("is two levels even for one ring", () => {
    const item = autosaveSubmenu([ring()], () => {}, T0, 0) as any;
    const projects = subOf(item);
    expect(projects).toHaveLength(1);
    expect(projects[0].label).toBe("Film.ngt");
    expect(subOf(projects[0])).toHaveLength(1);
  });

  it("names each ring by its label", () => {
    const item = autosaveSubmenu(
      [ring({ key: "f-a-A", label: "A.ngt" }), ring({ key: "s-b", label: "Untitled (13 Sep 09:12)" })],
      () => {},
      T0,
      0,
    ) as any;
    expect(subOf(item).map((p: any) => p.label)).toEqual([
      "A.ngt",
      "Untitled (13 Sep 09:12)",
    ]);
  });

  it("orders entries newest first whatever order they arrive in", () => {
    // LOAD-BEARING. The order *is* the information in a recovery list.
    const shuffled = ring({
      entries: [
        { file: "/c/mid.ngt", writtenAtMs: T0 },
        { file: "/c/old.ngt", writtenAtMs: T0 - 5 * MIN },
        { file: "/c/new.ngt", writtenAtMs: T0 + 5 * MIN },
      ],
    });
    const item = autosaveSubmenu([shuffled], () => {}, T0 + MIN, 0) as any;
    const labels = subOf(subOf(item)[0]).map((e: any) => e.label);
    expect(labels).toEqual([
      "Today 14:30:30",
      "Today 14:25:30",
      "Today 14:20:30",
    ]);
  });

  it("orders rings by their newest entry whatever order they arrive in", () => {
    const older = ring({
      key: "f-old-A",
      label: "Older.ngt",
      entries: [{ file: "/c/a.ngt", writtenAtMs: T0 - 10 * MIN }],
    });
    const newer = ring({
      key: "f-new-B",
      label: "Newer.ngt",
      entries: [{ file: "/c/b.ngt", writtenAtMs: T0 }],
    });
    const item = autosaveSubmenu([older, newer], () => {}, T0, 0) as any;
    expect(subOf(item).map((p: any) => p.label)).toEqual([
      "Newer.ngt",
      "Older.ngt",
    ]);
  });

  it("reports the key and file of the entry that was clicked, unaltered", () => {
    // LOAD-BEARING. A row that recovers something other than what it says is
    // the worst thing this menu could do, and nothing here parses either
    // value out of a label or an id.
    const picks: Array<[string, string]> = [];
    const item = autosaveSubmenu(
      [
        ring({
          key: "f-abc-Film",
          entries: [
            { file: "/cache/f-abc-Film/new.ngt", writtenAtMs: T0 + MIN },
            { file: "/cache/f-abc-Film/old.ngt", writtenAtMs: T0 },
          ],
        }),
        ring({
          key: "s-xyz",
          label: "Untitled",
          entries: [{ file: "/cache/s-xyz/one.ngt", writtenAtMs: T0 - MIN }],
        }),
      ],
      (key, file) => picks.push([key, file]),
      T0 + 2 * MIN,
      0,
    ) as any;

    const projects = subOf(item);
    subOf(projects[0])[1].click();
    subOf(projects[1])[0].click();

    expect(picks).toEqual([
      ["f-abc-Film", "/cache/f-abc-Film/old.ngt"],
      ["s-xyz", "/cache/s-xyz/one.ngt"],
    ]);
  });

  it("gives no entry an accelerator", () => {
    // A recovery replaces the whole timeline; it must never be one keystroke
    // away.
    const item = autosaveSubmenu([ring()], () => {}, T0, 0) as any;
    for (const project of subOf(item)) {
      expect(project.accelerator).toBeUndefined();
      for (const entry of subOf(project)) {
        expect(entry.accelerator).toBeUndefined();
      }
    }
  });

  it("drops a ring with no entries rather than offering an empty flyout", () => {
    const item = autosaveSubmenu(
      [ring({ key: "f-empty-E", label: "Empty", entries: [] }), ring()],
      () => {},
      T0,
      0,
    ) as any;
    expect(subOf(item).map((p: any) => p.label)).toEqual(["Film.ngt"]);
  });

  it("is the disabled row when every ring is empty", () => {
    const item = autosaveSubmenu(
      [ring({ entries: [] })],
      () => {},
      T0,
      0,
    ) as any;
    expect(item.enabled).toBe(false);
    expect(item.submenu).toBeUndefined();
  });

  it("holds 200 rows in order", () => {
    // 20 rings x 10 entries is the shipped cap. Ordering has to survive it.
    const many = Array.from({ length: 20 }, (_, r) =>
      ring({
        key: `f-${r}-P`,
        label: `P${r}.ngt`,
        entries: Array.from({ length: 10 }, (_, e) => ({
          file: `/c/${r}-${e}.ngt`,
          writtenAtMs: T0 - r * DAY - e * MIN,
        })),
      }),
    );
    const item = autosaveSubmenu(many, () => {}, T0, 0) as any;
    const projects = subOf(item);
    expect(projects).toHaveLength(20);
    expect(projects[0].label).toBe("P0.ngt");
    expect(projects[19].label).toBe("P19.ngt");
    expect(subOf(projects[0])).toHaveLength(10);
  });
});

describe("shouldRebuild", () => {
  it("declines an unchanged model", () => {
    expect(shouldRebuild([ring()], [ring()], false)).toBe(false);
  });

  it("accepts a changed model", () => {
    expect(
      shouldRebuild([ring()], [ring({ label: "Renamed.ngt" })], false),
    ).toBe(true);
  });

  it("notices a new entry in an existing ring", () => {
    const before = [ring()];
    const after = [
      ring({
        entries: [
          { file: "/c/a.ngt", writtenAtMs: T0 },
          { file: "/c/b.ngt", writtenAtMs: T0 + MIN },
        ],
      }),
    ];
    expect(shouldRebuild(before, after, false)).toBe(true);
  });

  it("notices a ring being dropped", () => {
    expect(shouldRebuild([ring()], [], false)).toBe(true);
  });

  it("declines while a menu is open, however different the model", () => {
    // `Menu.setApplicationMenu` closes an open menu on macOS, so rebuilding
    // here would snap the File menu shut under whoever is reading it.
    expect(shouldRebuild([ring()], [], true)).toBe(false);
  });
});

describe("signatureOf", () => {
  it("is stable for the same model", () => {
    expect(signatureOf([ring()])).toBe(signatureOf([ring()]));
  });

  it("changes with the file of an entry", () => {
    expect(
      signatureOf([ring({ entries: [{ file: "/c/x.ngt", writtenAtMs: T0 }] })]),
    ).not.toBe(signatureOf([ring()]));
  });

  it("changes with ring order", () => {
    const a = ring({ key: "f-a-A" });
    const b = ring({ key: "f-b-B" });
    expect(signatureOf([a, b])).not.toBe(signatureOf([b, a]));
  });

  it("is empty for no rings", () => {
    expect(signatureOf([])).toBe("");
  });
});
