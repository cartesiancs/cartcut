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

  it("is one flat row per recovery point", () => {
    // A ring keeps exactly one entry, so a second level would be a submenu of
    // one item every time — three levels of nesting to reach one choice.
    const item = autosaveSubmenu([ring()], () => {}, T0, 0) as any;
    const rows = subOf(item);
    expect(rows).toHaveLength(1);
    expect(rows[0].submenu).toBeUndefined();
  });

  it("names the project and the time in the same row", () => {
    // LOAD-BEARING for legibility: a flat list of bare times is Premiere's,
    // and being unable to tell which project a time belongs to is the single
    // most confusing thing about its recovery.
    const item = autosaveSubmenu([ring()], () => {}, T0, 0) as any;
    expect(subOf(item)[0].label).toBe("Film.ngt — Today 14:25:30");
  });

  it("names every ring, including an untitled one", () => {
    const item = autosaveSubmenu(
      [
        ring({ key: "f-a-A", label: "A.ngt" }),
        ring({
          key: "s-b",
          label: "Untitled (13 Sep 09:12)",
          entries: [{ file: "/c/b.ngt", writtenAtMs: T0 - MIN }],
        }),
      ],
      () => {},
      T0,
      0,
    ) as any;
    expect(subOf(item).map((r: any) => r.label)).toEqual([
      "A.ngt — Today 14:25:30",
      "Untitled (13 Sep 09:12) — Today 14:24:30",
    ]);
  });

  it("orders rows newest first whatever order they arrive in", () => {
    // LOAD-BEARING. The order *is* the information in a recovery list.
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
    expect(subOf(item).map((r: any) => r.label)).toEqual([
      "Newer.ngt — Today 14:25:30",
      "Older.ngt — Today 14:15:30",
    ]);
  });

  it("lists a ring that somehow holds several entries, newest first", () => {
    // The cap is a policy about what is *written*. A cache from an older
    // build, or files copied in by hand, must still be offered rather than
    // silently truncated to one.
    const shuffled = ring({
      entries: [
        { file: "/c/mid.ngt", writtenAtMs: T0 },
        { file: "/c/old.ngt", writtenAtMs: T0 - 5 * MIN },
        { file: "/c/new.ngt", writtenAtMs: T0 + 5 * MIN },
      ],
    });
    const item = autosaveSubmenu([shuffled], () => {}, T0 + MIN, 0) as any;
    expect(subOf(item).map((r: any) => r.label)).toEqual([
      "Film.ngt — Today 14:30:30",
      "Film.ngt — Today 14:25:30",
      "Film.ngt — Today 14:20:30",
    ]);
  });

  it("reports the key and file of the row that was clicked, unaltered", () => {
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

    const rows = subOf(item);
    rows[1].click();
    rows[2].click();

    expect(picks).toEqual([
      ["f-abc-Film", "/cache/f-abc-Film/old.ngt"],
      ["s-xyz", "/cache/s-xyz/one.ngt"],
    ]);
  });

  it("gives no row an accelerator", () => {
    // A recovery replaces the whole timeline; it must never be one keystroke
    // away.
    const item = autosaveSubmenu([ring()], () => {}, T0, 0) as any;
    for (const row of subOf(item)) {
      expect(row.accelerator).toBeUndefined();
    }
  });

  it("drops a ring with no entries rather than offering an empty flyout", () => {
    const item = autosaveSubmenu(
      [ring({ key: "f-empty-E", label: "Empty", entries: [] }), ring()],
      () => {},
      T0,
      0,
    ) as any;
    expect(subOf(item).map((r: any) => r.label)).toEqual([
      "Film.ngt — Today 14:25:30",
    ]);
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

  it("holds a row per project at the shipped caps, in order", () => {
    // 20 rings of one entry each is what ships: `MAX_RINGS` x `RING_SIZE`.
    const many = Array.from({ length: 20 }, (_, r) =>
      ring({
        key: `f-${r}-P`,
        label: `P${r}.ngt`,
        entries: [{ file: `/c/${r}.ngt`, writtenAtMs: T0 - r * DAY }],
      }),
    );
    const rows = subOf(autosaveSubmenu(many, () => {}, T0, 0) as any);
    expect(rows).toHaveLength(20);
    expect(rows[0].label).toContain("P0.ngt");
    expect(rows[19].label).toContain("P19.ngt");
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
