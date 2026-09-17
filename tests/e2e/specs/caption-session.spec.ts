/**
 * The caption session, in the running app.
 *
 * The node suites cover what it decides: `captionProjection.test.ts` holds the
 * sequence to the same document the batch builds, `captionSession.test.ts`
 * drives the state machine over fakes, and `timelineLock.test.ts` checks every
 * gate refuses. None of them can see whether any of it reaches the app, and
 * that is this spec's whole job.
 *
 * Four claims, and each of them is a data-loss bug if it is false:
 *
 * - the edit lands on the **real** timeline as soon as a transcript does, with
 *   no Apply pressed and **no undo step recorded**;
 * - the timeline is **locked** while it is live, so a drag cannot write over a
 *   document the next keystroke is going to rebuild;
 * - the silence toggle is **exact**, because both states come from the same
 *   baseline rather than from an inverse that `removeRanges` does not have;
 * - Apply costs **one** undo step and closing costs **none**.
 *
 * The transcript is seeded straight onto the panel, so this needs no
 * recogniser, no network and no model download. Everything after that is the
 * shipping path: the panel's own event, `Control`'s wiring, the real session,
 * the real store.
 */

import { test, expect } from "../harness/test";
import { agent, listClips, timelineDocument } from "../harness/agent";

/** Three lines, spread far enough apart to leave gaps worth cutting. */
const LINES = [
  { at: 0.5, text: "first line" },
  { at: 3.0, text: "second line" },
  { at: 5.5, text: "third line" },
].map((line, index) => {
  const words = line.text.split(" ").map((word, w) => ({
    word,
    start: line.at + w * 0.3,
    end: line.at + w * 0.3 + 0.25,
  }));
  return {
    id: `line-${index + 1}`,
    words,
    start: line.at,
    end: line.at + 0.8,
    text: line.text,
  };
});

/** Gaps between the lines, in source ms. What a real sweep would have found. */
const SILENCES = [
  { startMs: 1500, endMs: 2800 },
  { startMs: 4000, endMs: 5300 },
];

test("a transcript takes the timeline, and only Apply keeps it", async ({
  session,
  fixtures,
}) => {
  const page = session.page;
  const clip = fixtures.video.find((v) => v.id === "v01-h264-1080p60")!;

  await agent(session, "add_media", {
    items: [{ path: clip.path, startMs: 0, durationMs: 8000 }],
    sequential: false,
  });

  const { clips } = await listClips(session);
  const sourceKey = clips[0].id as string;

  /** Whatever the store currently holds, as the two numbers that matter. */
  const state = () =>
    page.evaluate(() => {
      const store = (window as any).CARTCUT.useTimelineStore.getState();
      const elements = Object.entries(store.timeline) as Array<[string, any]>;
      return {
        ids: elements.map(([id]) => id).sort(),
        captions: elements
          .filter(([, el]) => el.filetype === "text")
          .map(([, el]) => ({ text: el.text, start: el.startTime, dur: el.duration }))
          .sort((a, b) => a.start - b.start),
        pieces: elements.filter(([, el]) => el.filetype === "video").length,
        historyNow: store.history.historyNow,
        historyLength: store.history.timelineHistory.length,
        locked:
          (window as any).CARTCUT.timelineLockStore.getState().reason !== null,
      };
    });

  const before = await state();
  expect(before.captions).toHaveLength(0);
  expect(before.pieces).toBe(1);
  expect(before.locked).toBe(false);

  /**
   * Open the window the way `ControlUtilities` does, through the store, so this
   * does not depend on a tile's markup.
   *
   * Needed twice: Apply closes the window, which is deliberate. Leaving it open
   * on the setup screen after an edit was taken would read as the edit not
   * having been taken.
   */
  const openWindow = async () => {
    await page.evaluate(() => {
      (window as any).CARTCUT.windowStore.getState().open({
        id: "automaticCaption",
        hostId: "preview",
        placement: { mode: "docked", side: "right", sizePct: 46 },
        minSize: { width: 320, height: 240 },
      });
    });
    await expect(page.locator("automatic-caption")).toBeVisible({ timeout: 15_000 });
  };

  await openWindow();

  const seed = async () =>
    page.evaluate(
      ({ lines, silences, key }) => {
        const panel = document.querySelector("automatic-caption") as any;
        panel.lines = lines;
        panel.selectedKey = key;
        // What the sweep would have left behind, and the window it would have
        // been bounded by. Everything after this is the shipping path.
        panel._silenceRanges = silences;
        panel._sourceWindow = { startMs: 0, endMs: 8000 };
        panel._startSession();
      },
      { lines: LINES, silences: SILENCES, key: sourceKey },
    );

  await test.step("the captions and the cuts land without an undo step", async () => {
    await seed();
    // The reveal is paced over about a second, so wait for the last caption.
    await expect
      .poll(async () => (await state()).captions.length, { timeout: 15_000 })
      .toBe(3);

    const live = await state();
    // Two cuts in the middle of one clip leave three pieces.
    expect(live.pieces).toBe(3);
    // Not one entry more than the baseline the session recorded on the way in.
    expect(live.historyLength).toBeLessThanOrEqual(before.historyLength + 1);
    expect(live.historyNow).toBe(live.historyLength - 1);
  });

  await test.step("the timeline is locked, and says so", async () => {
    expect((await state()).locked).toBe(true);

    const ids = (await state()).ids;
    // The shipping refusal, through the command surface the toolbar, the menu
    // and every shortcut share.
    await page.evaluate((key) => {
      const cartcut = (window as any).CARTCUT;
      cartcut.selectionStore.getState().setIds([key]);
      cartcut.useTimelineStore.getState().setCursor(1000);
      cartcut.editorActions.splitSelection();
      cartcut.editorActions.deleteSelection();
      cartcut.editorActions.undo();
    }, ids.find((id) => id !== undefined)!);

    const after = await state();
    expect(after.ids, "an edit got past the lock").toEqual(ids);

    // A lock glyph in place of the track menu, so it is visible and not only
    // enforced.
    await expect(page.locator("element-timeline-left-option .track-lock").first())
      .toBeVisible();
  });

  await test.step("the silence toggle is exact over a round trip", async () => {
    const cut = await state();

    await page.evaluate(() => {
      (document.querySelector("automatic-caption") as any).toggleSilence(false);
    });
    await expect.poll(async () => (await state()).pieces, { timeout: 5_000 }).toBe(1);

    await page.evaluate(() => {
      (document.querySelector("automatic-caption") as any).toggleSilence(true);
    });
    await expect.poll(async () => (await state()).pieces, { timeout: 5_000 }).toBe(3);

    const again = await state();
    // The same clips, with the same names, back where they were. Anything less
    // would mean the toggle was rebuilding rather than restoring, which is what
    // `loadedAssetStore` would notice as a decoder it had to throw away.
    expect(again.ids).toEqual(cut.ids);
    expect(again.captions).toEqual(cut.captions);
  });

  await test.step("editing a caption reaches the timeline at once", async () => {
    await page.evaluate(() => {
      const field = document.querySelector(
        "app-window #analyzedEditCaption_0",
      ) as HTMLTextAreaElement;
      field.value = "corrected line";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await expect
      .poll(async () => (await state()).captions[0]?.text, { timeout: 5_000 })
      .toBe("corrected line");
    // Still nothing on the undo stack. Typing is not an edit until Apply.
    const live = await state();
    expect(live.historyNow).toBe(live.historyLength - 1);
  });

  // The field was a single-line input, so a long caption scrolled sideways and
  // could not be read whole. The node suites cannot see a layout, so the growth
  // is measured here, in the real panel, against the height it has at one line.
  await test.step("a long caption wraps and grows its field", async () => {
    const measure = () =>
      page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const field = document.querySelector(
          "app-window #analyzedEditCaption_0",
        ) as HTMLTextAreaElement;
        return {
          value: field.value,
          height: field.offsetHeight,
          clientWidth: field.clientWidth,
          scrollWidth: field.scrollWidth,
          clientHeight: field.clientHeight,
          scrollHeight: field.scrollHeight,
        };
      });
    const type = (value: string) =>
      page.evaluate((next) => {
        const field = document.querySelector(
          "app-window #analyzedEditCaption_0",
        ) as HTMLTextAreaElement;
        field.value = next;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);

    const oneLine = await measure();
    expect(oneLine.height).toBeGreaterThan(0);

    await type("word ".repeat(80).trim());
    const long = await measure();
    expect(long.height).toBeGreaterThan(oneLine.height);
    expect(long.scrollWidth).toBeLessThanOrEqual(long.clientWidth);
    expect(long.scrollHeight).toBeLessThanOrEqual(long.clientHeight);

    // A pasted break is a space, in the field and on the timeline alike, and
    // the field is back to one line once the text fits on one.
    await type("corrected\nline");
    await expect
      .poll(async () => (await state()).captions[0]?.text, { timeout: 5_000 })
      .toBe("corrected line");
    const pasted = await measure();
    expect(pasted.value).toBe("corrected line");
    expect(pasted.height).toBe(oneLine.height);
  });

  // Two things at once, and the second is the one that is easy to lose: a
  // struck-out line's span joins the ranges the session cuts, so the footage
  // under it goes and everything after it slides back. A caption that vanished
  // while the picture stayed put would be the panel editing only half of what
  // it says it edits.
  await test.step("striking a line out takes its caption and its footage", async () => {
    const before = await state();
    const secondStart = before.captions[1].start;
    const thirdStart = before.captions[2].start;

    // The second button on the second line: merge, then the scissors.
    await page.locator("app-window .caption").nth(1).locator(".caption-merge").nth(1).click();
    await expect
      .poll(async () => (await state()).captions.length, { timeout: 5_000 })
      .toBe(before.captions.length - 1);

    const after = await state();
    expect(after.captions.map((c) => c.text)).not.toContain("second line");
    // One more piece, because the cut fell in the middle of one.
    expect(after.pieces).toBe(before.pieces + 1);
    // And the caption after it moved back by what the cut removed, which is the
    // half a lane-local ripple would not do for the text track on its own.
    expect(after.captions[1].start).toBeLessThan(thirdStart);
    expect(thirdStart - after.captions[1].start).toBeGreaterThan(0);
    expect(after.captions[0].start).toBe(before.captions[0].start);
    void secondStart;
  });

  await test.step("putting it back restores the footage and the caption", async () => {
    const struck = await state();

    await page.locator("app-window .caption").nth(1).locator(".caption-merge").nth(1).click();
    await expect
      .poll(async () => (await state()).captions.length, { timeout: 5_000 })
      .toBe(struck.captions.length + 1);

    const restored = await state();
    expect(restored.pieces).toBe(struck.pieces - 1);
    expect(restored.captions.map((c) => c.text)).toContain("second line");
  });

  await test.step("Apply costs one undo step, and one press takes it all back", async () => {
    const live = await state();
    await page.locator("app-window .caption-apply").click();

    await expect.poll(async () => (await state()).locked, { timeout: 10_000 }).toBe(false);

    const applied = await state();
    expect(applied.historyLength).toBe(live.historyLength + 1);
    expect(applied.captions).toHaveLength(3);
    expect(applied.pieces).toBe(3);

    await page.evaluate(() => {
      (window as any).CARTCUT.editorActions.undo();
    });

    const undone = await state();
    expect(undone.captions, "one Cmd+Z did not take the whole session back")
      .toHaveLength(0);
    expect(undone.pieces).toBe(1);
  });

  await test.step("closing without applying discards", async () => {
    // Starting from wherever the undo above left the project, which is the
    // honest second session: a user who took one edit back and tried again.
    const baseline = await state();

    await openWindow();
    await seed();
    await expect
      .poll(async () => (await state()).captions.length, { timeout: 15_000 })
      .toBe(baseline.captions.length + 3);

    await page.locator("app-window .app-window-close").first().click();

    await expect.poll(async () => (await state()).locked, { timeout: 10_000 }).toBe(false);
    const after = await state();
    // Byte for byte, not merely the same counts: the baseline is held by
    // reference for the life of the session and written straight back, because
    // `removeRanges` has no inverse and nothing else could put the footage back.
    expect(after.ids, "a discarded session left something behind").toEqual(
      baseline.ids,
    );
    expect(after.captions).toEqual(baseline.captions);
    expect(after.pieces).toBe(baseline.pieces);
    expect(after.historyLength, "a discarded session cost an undo step").toBe(
      baseline.historyLength,
    );
  });

  // The document is the authority, not the store snapshot the steps above read.
  const doc = await timelineDocument(session);
  expect(Object.keys(doc).length).toBeGreaterThan(0);
});
