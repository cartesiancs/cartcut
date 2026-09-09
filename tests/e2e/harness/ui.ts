/**
 * Driving the editor the way a person does.
 *
 * Everything whose *wiring* is under test goes through here — the settings
 * inputs, the sidebar tabs, the export panel, the fx preset grid and the Render
 * button — because a store write would prove the store works while saying
 * nothing about whether the control still reaches it. Bulk placement goes
 * through `agent.ts` instead; see the note at the top of that file.
 *
 * Two things about this app's DOM shape decide most of the selectors below.
 *
 * **Custom elements are usually zero-area.** `createRenderRoot() { return this }`
 * is the pattern throughout, so components render into the light DOM and the
 * tag itself is an unstyled `display: inline` wrapper. `element-timeline-canvas`
 * measures 0x0 while the `#elementTimelineCanvasRef` inside it is 675x302.
 * Playwright treats a zero-area element as hidden, so selectors target the
 * inner control, never the tag.
 *
 * **Tab panes stay mounted.** The sidebar uses Bootstrap tabs and the inactive
 * panes keep their DOM, so a control can be *present* and still be zero-area
 * because its pane is hidden. Anything that clicks has to open the owning tab
 * first, which is what `openTab` is for.
 *
 * `#nav-home` has a second tab bar *inside* it — Canvas and Export — with the
 * same mounted-but-`d-none` behaviour one level down, which is what
 * `openSettingsTab` handles.
 */

import { expect, type Locator, type Page } from "@playwright/test";

import type { AppSession } from "./launch";

/** The sidebar panes, by the `data-bs-target` their buttons carry. */
export type SidebarTab =
  | "#nav-home"
  | "#nav-draft"
  | "#nav-text"
  | "#nav-util"
  | "#nav-option"
  | "#nav-fx";

export async function openTab(page: Page, target: SidebarTab): Promise<void> {
  await page.locator(`#sidebar button[data-bs-target="${target}"]`).click();
  // Bootstrap swaps `.active`/`.show` on the pane; waiting for the pane to have
  // a box is what actually says its controls are clickable.
  await page.waitForFunction((sel) => {
    const pane = document.querySelector(sel) as HTMLElement | null;
    return pane != null && pane.getBoundingClientRect().height > 0;
  }, target, { timeout: 15_000 });
}

/**
 * Open `#nav-home` and switch to one of its two panes.
 *
 * The project settings and the export settings were two sidebar tabs,
 * `#nav-home` and `#nav-output`. They are one panel now, split by a Canvas /
 * Export tab bar, so reaching a control takes both steps: open the sidebar tab,
 * then pick the half it lives in.
 *
 * Both panes stay mounted and the inactive one carries `d-none`, so a control
 * in it is present but zero-area — the same trap the sidebar's own panes set,
 * and the reason this cannot just fill by id.
 */
export async function openSettingsTab(
  page: Page,
  tab: "canvas" | "export" = "canvas",
): Promise<void> {
  await openTab(page, "#nav-home");
  await page.locator(`#nav-home [data-panel="${tab}"]`).click();

  // A control that exists only in the requested pane, so this waits on the tab
  // switch having landed rather than merely on the sidebar pane being open.
  const witness =
    tab === "canvas" ? "#projectFps" : "#nav-home select[data-setting], #nav-home .btn-group";
  await expect(page.locator(witness).first()).toBeVisible({ timeout: 15_000 });
}

// ------------------------------------------------------------ project setup

/**
 * Point the project at a folder, through the real picker.
 *
 * The settings panel's own "Select Folder" button is gone; `<asset-browser>` in
 * `#nav-draft` offers the same `selectProjectFolder()` on its empty state, and
 * that is now the only one. Both wrote the same two stores, so this is the same
 * wiring under test as before — reached from the panel that shows the files.
 *
 * The button is *replaced* by the file list once a directory is set, so its
 * disappearance is the signal that the pick landed. There is no store to poll:
 * `projectStore` is not among the diagnostics `index.ts` exposes on `CARTCUT`.
 */
export async function setProjectFolder(session: AppSession, dir: string): Promise<void> {
  const { page } = session;
  await openTab(page, "#nav-draft");

  const picker = page.locator("asset-browser button", { hasText: "Select Folder" });
  await session.answerOpenDialog([dir]);
  await picker.click();

  await expect(picker).toHaveCount(0, { timeout: 15_000 });
}

/** Set the export length via the minute/second inputs. */
export async function setDuration(page: Page, seconds: number): Promise<void> {
  await openSettingsTab(page);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;

  // `_handleUpdateDurationMinute` reads the *other* input with a bare
  // `querySelector().value`, so both must hold their final text before either
  // change event fires — otherwise the first handler computes against the old
  // value of the second field.
  await page.locator("#projectDurationMinute").fill(String(minutes));
  await page.locator("#projectDurationSecond").fill(String(rest));
  await page.locator("#projectDurationMinute").dispatchEvent("change");
  await page.locator("#projectDurationSecond").dispatchEvent("change");

  await expect
    .poll(() => page.evaluate(() => (globalThis as any).CARTCUT.renderOptionStore.getState().options.duration))
    .toBe(seconds);
}

export async function setResolution(page: Page, width: number, height: number): Promise<void> {
  await openSettingsTab(page);

  const preset = { "1920x1080": "1920x1080 (desktop)", "3840x2160": "3840x2160 (4k)", "1080x1080": "1080x1080 (square)", "1080x1920": "1080x1920 (mobile)" }[`${width}x${height}`];

  if (preset != null) {
    await page.locator("#nav-home button", { hasText: preset }).click();
  } else {
    // Note the DOM order: the height input comes first. Filling by id rather
    // than by position keeps that from mattering.
    await page.locator("#previewSizeH").fill(String(height));
    await page.locator("#previewSizeH").dispatchEvent("change");
    await page.locator("#previewSizeW").fill(String(width));
    await page.locator("#previewSizeW").dispatchEvent("change");
  }

  await expect
    .poll(() => page.evaluate(() => (globalThis as any).CARTCUT.renderOptionStore.getState().options.previewSize))
    .toEqual({ w: width, h: height });
}

export async function setBackgroundColor(page: Page, hex: string): Promise<void> {
  await openSettingsTab(page);
  await page.locator("#backgroundColor").fill(hex);
  await page.locator("#backgroundColor").dispatchEvent("input");
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).CARTCUT.renderOptionStore.getState().options.backgroundColor))
    .toBe(hex);
}

/**
 * Set the project frame rate.
 *
 * A real UI action now. It used to write the store directly, because the fps
 * field shipped `disabled` at a hardcoded 60 and there was no control to drive
 * — which meant the one part of the frame-rate path the user actually touches
 * was the one part nothing tested. The field is in #nav-home's Canvas tab.
 *
 * The store poll stays: the assertion is not "the field accepted the text" but
 * "the field's handler reached the store", which is the wiring under test.
 */
export async function setFps(page: Page, fps: number): Promise<void> {
  await openSettingsTab(page);
  await page.locator("#projectFps").fill(String(fps));
  await page.locator("#projectFps").dispatchEvent("change");

  await expect
    .poll(() => page.evaluate(() => (globalThis as any).CARTCUT.renderOptionStore.getState().options.fps))
    .toBe(fps);
}

// ---------------------------------------------------------- export settings

export type ExportPresetName = "high" | "medium" | "low";

export async function setExportPreset(page: Page, name: ExportPresetName): Promise<void> {
  await openSettingsTab(page, "export");
  await page.locator("#nav-home button", { hasText: new RegExp(`^\\s*${name}\\s*$`, "i") }).first().click();
  await expect
    .poll(() =>
      page.evaluate(() => (globalThis as any).CARTCUT.renderOptionStore.getState().options.exportSettings),
    )
    .toMatchObject({ container: expect.any(String) });
}

/** Open the advanced panel and set one `select[data-setting=...]`. */
export async function setExportSetting(page: Page, key: string, value: string): Promise<void> {
  await openSettingsTab(page, "export");
  const advanced = page.locator("#nav-home", { hasText: "Advanced settings" });
  const select = page.locator(`#nav-home select[data-setting="${key}"]`);
  if ((await select.count()) === 0 || !(await select.first().isVisible())) {
    await advanced.locator("button", { hasText: /advanced/i }).first().click();
  }
  await select.first().selectOption(value);
}

export async function currentExportSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () => (globalThis as any).CARTCUT.renderOptionStore.getState().options.exportSettings,
  );
}

// ---------------------------------------------------------------- fx panels

/**
 * Apply a transition preset by clicking its tile.
 *
 * `fxPresetBrowser.applyTransition` puts the transition on **the bare cut
 * nearest the playhead, on the selected clip's track**. So the caller selects a
 * clip and moves the playhead, and the click lands the transition exactly where
 * intended — precise control through the real control, with no synthetic drag
 * and no production code that exists only for tests.
 *
 * There is no agent command for transitions or effects (`define.ts`'s
 * `FILETYPES` omits both), so this is the only way to place one.
 */
export async function applyFxPreset(
  page: Page,
  kind: "effect" | "transition",
  presetName: string,
  options: { selectElementId?: string | null; playheadMs?: number } = {},
): Promise<void> {
  await openTab(page, "#nav-fx");
  await page.locator("control-ui-fx button", { hasText: kind === "effect" ? "Effects" : "Transitions" }).click();

  // Selection and playhead are set *after* the tab is open, not before.
  // Switching sidebar tabs clears the selection, and `applyTransition` reads
  // `selectionStore.getState().ids[0]` — with an empty selection it toasts
  // "Select a clip next to a cut" and places nothing, which is silent from the
  // caller's point of view.
  if (options.playheadMs != null) {
    await page.evaluate(
      (atMs) => (globalThis as any).CARTCUT.useTimelineStore.getState().setCursor?.(atMs),
      options.playheadMs,
    );
  }
  if (options.selectElementId !== undefined) {
    await page.evaluate(
      (id) => (globalThis as any).CARTCUT.selectionStore.getState().setIds(id == null ? [] : [id]),
      options.selectElementId,
    );
    const selected = await page.evaluate(
      () => (globalThis as any).CARTCUT.selectionStore.getState().ids,
    );
    if (options.selectElementId != null && selected[0] !== options.selectElementId) {
      throw new Error(
        `selection did not take before clicking the ${kind} tile (wanted ${options.selectElementId}, got ${JSON.stringify(selected)})`,
      );
    }
  }

  const browser = page.locator(`fx-preset-browser[kind="${kind}"]`);
  // Tiles carry the preset name in `title` — "Name" or "Name — Author". Matched
  // case-insensitively against the leading segment, because the display names
  // come from each preset's own `manifest.json` and are Title Case there
  // ("Linear Wipe", "Iris Circle") in ways a caller should not have to guess.
  const tile = browser
    .locator("div.asset")
    .filter({
      has: undefined,
      hasNotText: undefined,
    })
    .filter({
      hasText: new RegExp(`^\\s*${presetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"),
    })
    .first();

  if ((await tile.count()) === 0) {
    const available = await fxPresetNames(page, kind);
    throw new Error(
      `no ${kind} preset named "${presetName}". Available: ${available.join(", ")}`,
    );
  }
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.click();
}

export async function fxPresetNames(page: Page, kind: "effect" | "transition"): Promise<string[]> {
  await openTab(page, "#nav-fx");
  await page.locator("control-ui-fx button", { hasText: kind === "effect" ? "Effects" : "Transitions" }).click();
  return page.evaluate((k) => {
    const browser = document.querySelector(`fx-preset-browser[kind="${k}"]`);
    return Array.from(browser?.querySelectorAll("div.asset") ?? []).map(
      (tile) => (tile.getAttribute("title") ?? "").split(" — ")[0],
    );
  }, kind);
}

// ----------------------------------------------------------------- playback

export async function stopPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control: any = document.querySelector("element-control");
    if (control?.isPlay) control.stop?.();
  });
}

/** Clear the selection so no outline is composited into a preview capture. */
export async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as any).CARTCUT.selectionStore.getState().setIds([]));
}

export function timelineCanvas(page: Page): Locator {
  return page.locator("#elementTimelineCanvasRef");
}

export function previewCanvas(page: Page): Locator {
  return page.locator("#elementPreviewCanvasRef");
}
