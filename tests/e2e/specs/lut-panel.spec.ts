/**
 * The LUT panel, in the running app.
 *
 * Everything else about LUTs is checked without a UI — the parsers, the
 * sampler, the ops and the export all have suites of their own, and
 * `lut.spec.ts` drives the whole pipeline through the agent surface. What none
 * of them can see is whether the *panel* works, and the first version of it
 * did not: the pills that make up the sidebar mount every pane at app startup,
 * so this component rendered once inside a `display: none` pane, correctly
 * skipped painting, and was never asked again — because clicking a tab changes
 * no property Lit is watching. Eighty tiles, all blank, no error anywhere.
 *
 * So this spec asserts the thing that was broken: open the panel, and the tiles
 * have pictures in them. It is deliberately cheap — no export, no media — and
 * it is the only test in the suite that would have caught it.
 *
 * The panel is reached in two clicks: the "Fx" sidebar pill, then the "LUTs"
 * toggle inside `<control-ui-fx>`, which shares that tab with the effect and
 * transition grids. The hidden-at-startup problem above survives the move — the
 * grid mounts inside a `d-none` div and is still un-painted until the toggle
 * reveals it — so this is the same test, aimed one level deeper.
 */

import path from "node:path";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";
import { writeJson } from "../harness/artifacts";

test("the LUT panel paints every tile when its tab is opened", async ({
  session,
  artifactDir,
}) => {
  test.setTimeout(120_000);
  const { page } = session;

  await test.step("the tab exists and the pane is wired to it", async () => {
    const wiring = await page.evaluate(() => ({
      button: document.querySelector('button[data-bs-target="#nav-fx"]') != null,
      pane: document.querySelector("#nav-fx") != null,
      toggle:
        document.querySelector('control-ui-fx button[data-panel="lut"]') != null,
      browser: document.querySelector("#nav-fx lut-browser") != null,
    }));
    expect(wiring).toEqual({
      button: true,
      pane: true,
      toggle: true,
      browser: true,
    });
  });

  await test.step("opening it lays out all eighty, under their headings", async () => {
    await page.evaluate(() => {
      (
        document.querySelector(
          'button[data-bs-target="#nav-fx"]',
        ) as HTMLElement | null
      )?.click();
      (
        document.querySelector(
          'control-ui-fx button[data-panel="lut"]',
        ) as HTMLElement | null
      )?.click();
    });

    // The tiles are graded on a background task — a still is rendered, then
    // eighty tables are read off disk and applied — so poll rather than guess
    // at a delay.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const tiles = document.querySelectorAll(
              "lut-browser canvas[data-lut]",
            );
            let painted = 0;
            for (const node of tiles) {
              const canvas = node as HTMLCanvasElement;
              const ctx = canvas.getContext("2d");
              if (ctx == null) continue;
              const [r, g, b, a] = ctx.getImageData(4, 4, 1, 1).data;
              // The tile's CSS background is a flat dark grey and the canvas
              // itself starts transparent, so any opaque non-black pixel means
              // something was actually drawn into it.
              if (a > 0 && (r > 0 || g > 0 || b > 0)) painted++;
            }
            return { tiles: tiles.length, painted };
          }),
        { timeout: 60_000, message: "the LUT tiles never painted" },
      )
      .toEqual({ tiles: 80, painted: 80 });
  });

  await test.step("every category has a heading of its own", async () => {
    const headings = await page.evaluate(() =>
      [...document.querySelectorAll("lut-browser .text-secondary")]
        .map((n) => (n as HTMLElement).innerText.trim())
        .filter((t) => t === t.toUpperCase() && t.length > 0 && t.length < 24),
    );
    for (const label of [
      "FILM",
      "CINEMATIC",
      "VINTAGE",
      "BLACK & WHITE",
      "WARM",
      "COOL",
      "VIVID",
      "MATTE",
      "LOG CONVERSION",
      "UTILITY",
    ]) {
      expect(headings, `${label} has no heading`).toContain(label);
    }
  });

  await test.step("no two tiles look the same", async () => {
    // The anti-tautology guard, and the one that would catch a panel painting
    // the *ungraded* still eighty times — which is what a broken resolver, a
    // dead applier or a cache keyed on the wrong thing all look like.
    const digests = await page.evaluate(() =>
      [...document.querySelectorAll("lut-browser canvas[data-lut]")].map(
        (node) => {
          const canvas = node as HTMLCanvasElement;
          const ctx = canvas.getContext("2d")!;
          // A handful of points, quantised — enough to separate eighty grades
          // without being sensitive to a one-step difference.
          const points = [
            [20, 12],
            [96, 12],
            [40, 50],
            [150, 50],
            [96, 90],
            [30, 100],
          ];
          return points
            .map(([x, y]) => {
              const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
              return `${r >> 3},${g >> 3},${b >> 3}`;
            })
            .join("|");
        },
      ),
    );
    writeJson(path.join(artifactDir, "tile-digests.json"), digests);
    expect(digests).toHaveLength(80);
    // Not all eighty distinct — two gentle grades can quantise together at six
    // sample points — but a panel showing one picture eighty times is what this
    // refuses, and it refuses it with a lot of room to spare.
    expect(new Set(digests).size).toBeGreaterThan(60);
  });

  await test.step("the tiles do not change when the project or playhead does", async () => {
    // The property the panel is built on. A thumbnail sourced from the
    // timeline would move under the user every time the playhead did, and two
    // LUTs compared ten seconds apart would have been judged against
    // different pictures — with nothing on screen saying so.
    const digest = () =>
      page.evaluate(() => {
        const canvas = document.querySelector(
          "lut-browser canvas[data-lut]",
        ) as HTMLCanvasElement;
        return [...canvas.getContext("2d")!.getImageData(0, 0, 24, 24).data].join(",");
      });

    const before = await digest();

    // Move the playhead a long way, add a clip, and select it. Any of the
    // three would have changed a timeline-sourced thumbnail.
    await page.evaluate(() => {
      (globalThis as any).CARTCUT.useTimelineStore.getState().setCursor(4200);
    });
    await agent(session, "add_shape", {
      kind: "rectangle",
      startMs: 0,
      durationMs: 6000,
      fillColor: "#ff3300",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    await page.waitForTimeout(1500);

    expect(await digest()).toBe(before);
  });

  await test.step("nothing in the panel or the inspector calls a LUT a filter", async () => {
    /**
     * The naming rule, enforced rather than asserted in a comment.
     *
     * `VideoElementType.filter` and `set_video_filters` already own the word
     * "filter" in this app, for the chroma key and the two blurs — and that
     * feature's controls sit in the *same inspector* as this one. Two things
     * called a filter is a UI nobody can describe, so this scans the copy the
     * user actually reads and refuses the word outright.
     *
     * Scoped to the LUT surfaces on purpose: `optionVideo`'s own filter
     * controls are a different feature and are correctly named.
     */
    const id = await agent<any>(session, "add_shape", {
      kind: "rectangle",
      startMs: 0,
      durationMs: 4000,
      fillColor: "#4d8fc4",
      x: 0,
      y: 0,
      width: 320,
      height: 240,
    }).then((r) => r?.created?.[0]);
    expect(id).toBeTruthy();

    await agent(session, "set_lut", {
      elementIds: [id],
      presetId: "com.cartcut.lut.print-2383",
    });
    await agent(session, "select_clips", { elementIds: [id] });

    // The inspector column learns which clip it is showing from
    // `optionGroup.showOption`, which only fires on a mousedown on the timeline
    // canvas — an agent selection does not reach it. `<blend-mode>` has exactly
    // the same wiring, so this is the inspector's existing behaviour rather
    // than anything about LUTs; the property is set directly here because what
    // is under test is the *wording*, not the selection plumbing.
    await page.evaluate((elementId) => {
      for (const node of document.querySelectorAll("option-lut-section")) {
        (node as any).elementId = elementId;
        (node as any).requestUpdate?.();
      }
    }, id);
    await page.waitForTimeout(600);

    const copy = await page.evaluate(() => {
      // `textContent`, not `innerText`. The inspector column stays collapsed
      // when the selection came from the agent rather than from a click on the
      // canvas, and `innerText` is layout-dependent — it reads empty for a
      // hidden element, which would make this check quietly vacuous.
      const read = (selector: string) =>
        [...document.querySelectorAll(selector)]
          .map((n) => {
            const element = n as HTMLElement;
            const attributes = [
              element.getAttribute("placeholder") ?? "",
              element.getAttribute("title") ?? "",
            ].join(" ");
            return `${element.textContent ?? ""} ${attributes}`;
          })
          .join(" ");
      return {
        // Scoped to the grid itself, not to the whole `#nav-fx` pane: the pane
        // now also holds the effect and transition browsers, and that feature
        // is allowed the word "filter" this check refuses.
        panel: read("#nav-fx lut-browser, #nav-fx lut-browser *"),
        inspector: read("option-lut-section, option-lut-section *"),
        // The panel toggle's own tooltip and label.
        tab: read('control-ui-fx button[data-panel="lut"]'),
      };
    });

    // The inspector row only renders for a clip that can carry one, so an
    // empty string here would make the check below vacuous.
    expect(copy.inspector.toUpperCase()).toContain("LUT");
    expect(copy.panel.toUpperCase()).toContain("LUT");

    for (const [where, text] of Object.entries(copy)) {
      expect(text.toLowerCase(), `${where} says "filter"`).not.toContain("filter");
    }
  });

  await page.screenshot({ path: path.join(artifactDir, "lut-panel.png") });
});
