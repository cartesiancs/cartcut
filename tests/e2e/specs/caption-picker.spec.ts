/**
 * The clip picker, in the running app.
 *
 * `clipPick.test.ts`, `clipTray.test.ts` and `clipTile.test.ts` hold every
 * decision the picker makes. What only the app can answer is whether the
 * overlay is really dark over a light Bootstrap, whether a click and a
 * keystroke reach those decisions, and whether a keystroke meant for the
 * picker is kept away from the timeline, where Backspace deletes the
 * selected clip.
 *
 * No transcription: Start is intercepted on the panel, so this checks the order
 * the picker hands over and nothing after it.
 */

import { test, expect } from "../harness/test";
import { agent, listClips } from "../harness/agent";

test("the clip picker chooses several clips, in an order the user sets", async ({
  session,
  fixtures,
}) => {
  const page = session.page;
  const clip = fixtures.video.find((v) => v.id === "v01-h264-1080p60")!;

  await agent(session, "add_media", {
    items: [
      { path: clip.path, startMs: 0 },
      { path: clip.path, startMs: 60_000 },
    ],
    sequential: false,
  });
  const { clips } = await listClips(session);
  const videos = clips
    .filter((c) => c.type === "video")
    .sort((a, b) => a.start - b.start);
  expect(videos).toHaveLength(2);
  const [first, second] = videos.map((c) => c.id);

  await page.evaluate(() => {
    (window as any).CARTCUT.windowStore.getState().open({
      id: "automaticCaption",
      hostId: "preview",
      placement: { mode: "docked", side: "right", sizePct: 46 },
      minSize: { width: 320, height: 240 },
    });
  });
  await expect(page.locator("automatic-caption")).toBeVisible({ timeout: 15_000 });

  // Start hands the order to the panel, which would transcribe. Keep the order
  // and stop there.
  await page.evaluate(() => {
    const panel = document.querySelector("automatic-caption") as any;
    panel.startChosenClips = async () => {
      (window as any).__pickedOrder = [...panel._pick];
    };
  });

  const tile = (key: string) => page.locator(`.clip-tile[data-key="${key}"]`);
  const badge = (key: string) => tile(key).locator(".clip-tile-badge");
  const chipKeys = () =>
    page.locator(".clip-chip").evaluateAll((chips) =>
      chips.map((chip) => (chip as HTMLElement).dataset.key),
    );

  await test.step("opens dark, with a tile per clip and nothing chosen", async () => {
    await page.locator("app-window .caption-clips-btn").click();
    const card = page.locator("caption-clip-picker .clip-picker");
    await expect(card).toBeVisible();
    const background = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).toBe("rgb(25, 24, 26)");
    await expect(page.locator(".clip-tile")).toHaveCount(2);
    await expect(page.locator(".clip-chip")).toHaveCount(0);
    await expect(page.locator(".clip-picker-start")).toBeDisabled();
  });

  await test.step("numbers the clips in the order they are clicked", async () => {
    await tile(second).click();
    await tile(first).click();
    await expect(badge(second)).toHaveText("1");
    await expect(badge(first)).toHaveText("2");
    expect(await chipKeys()).toEqual([second, first]);
  });

  await test.step("moves a chip with Option and the arrow keys", async () => {
    await page.locator(".clip-chip").first().focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(chipKeys).toEqual([first, second]);
    await expect(badge(first)).toHaveText("1");
    // The chip that moved keeps the focus, so it can be moved again.
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.key,
    );
    expect(focused).toBe(second);
  });

  await test.step("moves a chip by dragging it past its neighbour", async () => {
    const chips = page.locator(".clip-chip");
    const from = await chips.nth(0).boundingBox();
    const to = await chips.nth(1).boundingBox();
    expect(from && to).toBeTruthy();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + to!.width, to!.y + to!.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(chipKeys).toEqual([second, first]);
  });

  await test.step("keeps Backspace away from the timeline", async () => {
    const before = (await listClips(session)).clips.length;
    await page.evaluate((key) => {
      (window as any).CARTCUT.selectionStore.getState().setIds([key]);
    }, first);
    await tile(first).focus();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Delete");
    expect((await listClips(session)).clips.length).toBe(before);
  });

  await test.step("removes a chip from the tray", async () => {
    await page.locator(".clip-chip").first().focus();
    await page.keyboard.press("Backspace");
    await expect.poll(chipKeys).toEqual([first]);
    await expect(badge(second)).toHaveText("");
  });

  await test.step("remembers the choice across Escape, and hands it over on Start", async () => {
    await page.keyboard.press("Escape");
    await expect(page.locator("caption-clip-picker .clip-picker")).toHaveCount(0);

    await page.locator("app-window .caption-clips-btn").click();
    await expect(badge(first)).toHaveText("1");
    await tile(second).click();

    await page.locator(".clip-picker-start").click();
    await expect(page.locator("caption-clip-picker .clip-picker")).toHaveCount(0);
    const order = await page.evaluate(() => (window as any).__pickedOrder);
    expect(order).toEqual([first, second]);
  });
});
