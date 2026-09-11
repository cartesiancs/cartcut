/**
 * The Adjust tab, in the running app.
 *
 * The ops, the pixels and the agent surface all have suites of their own, and
 * `adjust.spec.ts` drives the whole pipeline through the agent. What none of
 * them can see is the panel: that it mounts in every clip inspector, that it
 * lays out fifteen sliders under three headings, and — the claim that matters
 * most to someone using it — that **a drag across a slider is one undo step**
 * however many values it passed through, because it writes through
 * `GestureCommit` rather than a checkpoint per `input` event.
 *
 * Deliberately cheap: no export, no media.
 */

import path from "node:path";

import { test, expect } from "../harness/test";
import { agent } from "../harness/agent";

const KEYS = [
  "temperature",
  "tint",
  "saturation",
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "brilliance",
  "sharpen",
  "clarity",
  "particles",
  "fade",
  "vignette",
];

test("the Adjust tab scrubs as one undo step and resets cleanly", async ({
  session,
  artifactDir,
}) => {
  test.setTimeout(120_000);
  const { page } = session;

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

  /** The clip's `adjust` field as stored, and the depth of the undo stack. */
  const read = () =>
    page.evaluate((elementId) => {
      const state = (globalThis as any).CARTCUT.useTimelineStore.getState();
      return {
        adjust: state.timeline[elementId]?.adjust ?? null,
        history: state.history.timelineHistory.length,
      };
    }, id);

  await test.step("every clip inspector carries the tab and the section", async () => {
    const wiring = await page.evaluate(() =>
      ["option-video", "option-image", "option-shape", "option-text"].map((tag) => ({
        tag,
        tab: document.querySelector(`${tag} option-tab-bar`) == null
          ? null
          : document.querySelector(`${tag} button[data-panel="adjust"]`) != null,
        section: document.querySelector(`${tag} option-adjust-section`) != null,
      })),
    );
    for (const row of wiring) {
      expect(row.section, `${row.tag} has no <option-adjust-section>`).toBe(true);
      if (row.tab != null) {
        expect(row.tab, `${row.tag} has no Adjust tab`).toBe(true);
      }
    }
  });

  // As in `lut-panel.spec.ts`: the inspector learns its clip from a mousedown
  // on the timeline canvas, which an agent selection never produces. So the
  // clip is handed over directly — to the *inspector*, not to the section.
  // `<option-shape>` re-renders on every document change and passes its own
  // `elementId` down as it does, so a section pointed at the clip on its own is
  // emptied again by the first edit that follows, which is every step below.
  await page.evaluate((elementId) => {
    for (const node of document.querySelectorAll("option-shape")) {
      (node as any).elementId = elementId;
      (node as any).requestUpdate?.();
    }
  }, id);
  const section = "option-shape option-adjust-section";
  await expect
    .poll(() => page.evaluate((s) => document.querySelectorAll(`${s} [data-adjust]`).length, section))
    .toBe(15);

  await test.step("fifteen sliders under three headings, in CapCut's order", async () => {
    const layout = await page.evaluate((s) => {
      const root = document.querySelector(s)!;
      return {
        groups: [...root.querySelectorAll("[data-adjust-group]")].map((g) => ({
          group: g.getAttribute("data-adjust-group"),
          keys: [...g.querySelectorAll("[data-adjust]")].map((r) => r.getAttribute("data-adjust")),
        })),
        ranges: [...root.querySelectorAll('[data-adjust] input[type="range"]')].map((r) => [
          (r as HTMLInputElement).min,
          (r as HTMLInputElement).max,
          (r as HTMLInputElement).value,
        ]),
      };
    }, section);

    expect(layout.groups.map((g) => g.group)).toEqual(["color", "lightness", "effects"]);
    expect(layout.groups.flatMap((g) => g.keys)).toEqual(KEYS);
    // Every slider starts at neutral, and the four one-sided effects start at their end.
    for (const [i, [min, max, value]] of layout.ranges.entries()) {
      expect(value, KEYS[i]).toBe("0");
      expect(max, KEYS[i]).toBe("100");
      expect(min, KEYS[i]).toBe(
        ["sharpen", "clarity", "particles", "fade"].includes(KEYS[i]) ? "0" : "-100",
      );
    }
  });

  // The first edit after a load lays down an undo baseline nothing else
  // records (CLAUDE.md, "Known rough edges"); get it out of the way so what
  // follows measures the gesture alone.
  await agent(session, "set_color_adjustments", { elementIds: [id], adjustments: { tint: 1 } });
  await agent(session, "set_color_adjustments", { elementIds: [id], reset: "all" });

  await test.step("a drag through ten values is one undo step", async () => {
    const before = await read();
    await page.evaluate((s) => {
      const slider = document.querySelector(
        `${s} [data-adjust="exposure"] input[type="range"]`,
      ) as HTMLInputElement;
      for (const value of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) {
        slider.value = String(value);
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }, section);

    await expect.poll(async () => (await read()).adjust).toEqual({ exposure: 50 });
    const after = await read();
    expect(after.history - before.history).toBe(1);
  });

  await test.step("a typed value lands as one step too", async () => {
    const before = await read();
    await page.evaluate((s) => {
      const box = document.querySelector(
        `${s} [data-adjust="vignette"] input[type="number"]`,
      ) as HTMLInputElement;
      box.value = "-30";
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }, section);
    await expect.poll(async () => (await read()).adjust).toEqual({ exposure: 50, vignette: -30 });
    expect((await read()).history - before.history).toBe(1);
  });

  await test.step("double-clicking a name resets that slider and nothing else", async () => {
    await page.evaluate((s) => {
      const label = document.querySelector(`${s} [data-adjust="exposure"] label`)!;
      label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }, section);
    await expect.poll(async () => (await read()).adjust).toEqual({ vignette: -30 });
  });

  await test.step("a group's Reset clears that group only", async () => {
    await agent(session, "set_color_adjustments", {
      elementIds: [id],
      adjustments: { temperature: 20, shadows: 15 },
    });
    await page.evaluate((s) => {
      (document.querySelector(`${s} [data-adjust-group="effects"] button`) as HTMLElement).click();
    }, section);
    await expect.poll(async () => (await read()).adjust).toEqual({ temperature: 20, shadows: 15 });
  });

  await test.step("Reset all removes the field outright", async () => {
    await page.evaluate((s) => {
      const buttons = [...document.querySelectorAll(`${s} button`)] as HTMLButtonElement[];
      buttons[buttons.length - 1].click();
    }, section);
    await expect.poll(async () => (await read()).adjust).toBeNull();
    const inTimeline = await page.evaluate(
      (elementId) =>
        "adjust" in (globalThis as any).CARTCUT.useTimelineStore.getState().timeline[elementId],
      id,
    );
    expect(inTimeline).toBe(false);
  });

  await test.step("the sliders follow an edit made elsewhere", async () => {
    // The section subscribes to the document, so an agent's edit moves the
    // slider under the user's hand rather than leaving it stale.
    await agent(session, "set_color_adjustments", { elementIds: [id], adjustments: { fade: 60 } });
    await expect
      .poll(() =>
        page.evaluate(
          (s) =>
            (document.querySelector(`${s} [data-adjust="fade"] input[type="range"]`) as HTMLInputElement)
              .value,
          section,
        ),
      )
      .toBe("60");
  });

  await test.step("the tab opens and shows the panel, as a click on the clip would", async () => {
    // Every step above reads the DOM whether or not it is on screen. This one
    // opens the inspector column the way a mousedown on the timeline does —
    // `option-group#showOption` — clicks the tab, and requires the section to
    // be *displayed*, so the screenshot below is of the panel a user sees.
    await agent(session, "set_color_adjustments", {
      elementIds: [id],
      adjustments: { temperature: 35, exposure: 20, shadows: 25, vignette: 40 },
    });
    await page.evaluate((elementId) => {
      (document.querySelector("option-group") as any).showOption({
        filetype: "shape",
        elementId,
      });
      (document.querySelector('option-shape button[data-panel="adjust"]') as HTMLElement).click();
    }, id);

    await expect
      .poll(() =>
        page.evaluate((s) => {
          const root = document.querySelector(s) as HTMLElement | null;
          if (root == null) return { shown: false, rows: 0 };
          const box = root.getBoundingClientRect();
          return {
            shown: box.width > 0 && box.height > 0,
            rows: root.querySelectorAll("[data-adjust]").length,
          };
        }, section),
      )
      .toEqual({ shown: true, rows: 15 });

    const values = await page.evaluate(
      (s) =>
        Object.fromEntries(
          [...document.querySelectorAll(`${s} [data-adjust]`)].map((row) => [
            row.getAttribute("data-adjust"),
            (row.querySelector('input[type="range"]') as HTMLInputElement).value,
          ]),
        ),
      section,
    );
    expect(values).toMatchObject({
      temperature: "35",
      exposure: "20",
      shadows: "25",
      vignette: "40",
      fade: "60",
      tint: "0",
    });
  });

  await test.step("four tabs never overflow: icons when narrow, names when there is room", async () => {
    // A fifth-of-a-column button cannot hold a name, and truncating one to
    // "M··" is worse than not showing it. So the bar shows icons with tooltips
    // below the width where four names fit, and names above it.
    const measure = () =>
      page.evaluate(() => {
        const bar = document.querySelector("option-shape option-tab-bar") as HTMLElement;
        const row = bar.querySelector(".d-flex") as HTMLElement;
        const labels = [...bar.querySelectorAll(".option-tab-label")] as HTMLElement[];
        return {
          buttons: bar.querySelectorAll("button[data-panel]").length,
          overflows: row.scrollWidth > row.clientWidth + 1,
          labelsShown: labels.filter((l) => getComputedStyle(l).display !== "none").length,
          titled: [...bar.querySelectorAll("button[data-panel]")].every(
            (b) => (b.getAttribute("title") ?? "") !== "",
          ),
        };
      });

    const narrow = await measure();
    expect(narrow.buttons).toBe(4);
    expect(narrow.overflows).toBe(false);
    expect(narrow.titled).toBe(true);

    // Widened at the container itself. `<option-tab-bar>` is a custom element
    // and so `display: inline` by default, where `width` does nothing — sizing
    // the host would leave the container exactly as narrow as it was.
    const container = "option-shape option-tab-bar .option-tabs-crowded";
    await page.evaluate((selector) => {
      (document.querySelector(selector) as HTMLElement).style.width = "360px";
    }, container);
    const wide = await measure();
    expect(wide.overflows).toBe(false);
    expect(wide.labelsShown).toBe(4);
    await page.evaluate((selector) => {
      (document.querySelector(selector) as HTMLElement).style.width = "";
    }, container);
  });

  await page.screenshot({ path: path.join(artifactDir, "adjust-panel.png") });
});
