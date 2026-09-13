/**
 * Auto Save, through the real app.
 *
 * The unit suites cover the state machine, the digest and the cache in
 * isolation. What only a running app can answer is whether the three halves
 * are actually connected: a store write reaches the session, the session's
 * bytes reach `userData/autosave`, and a save retires the ring.
 *
 * The second test is the one that matters most, and it is deliberately brutal:
 * it kills the app with no graceful close, which is the disaster the whole
 * feature exists for, and then requires (a) the work to come back, (b) the
 * original `.ngt` to be byte-identical to what was saved, and (c) the session
 * to be detached so ⌘S cannot overwrite that file with older state.
 */

import fs from "node:fs";
import path from "node:path";

import { test, expect } from "../harness/test";
import { launchApp } from "../harness/launch";

/** Every ring directory currently in the cache. */
function rings(userDataDir: string): string[] {
  const root = path.join(userDataDir, "autosave");
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root)
    .filter((name) => fs.statSync(path.join(root, name)).isDirectory());
}

/** Every recovery point in the cache, as absolute paths. */
function entries(userDataDir: string): string[] {
  const root = path.join(userDataDir, "autosave");
  return rings(userDataDir).flatMap((key) =>
    fs
      .readdirSync(path.join(root, key))
      .filter((name) => name.endsWith(".ngt"))
      .map((name) => path.join(root, key, name)),
  );
}

/** Put one text clip on the timeline, as one undo step. */
async function addClip(page: any, text: string): Promise<void> {
  await page.evaluate((body: string) => {
    const C = (globalThis as any).CARTCUT;
    const store = C.useTimelineStore.getState();
    store.patchDocument({
      schemaVersion: 2,
      tracks: [{ id: "t1", kind: "text", name: "T1", index: 0 }],
      elements: {
        ...C.useTimelineStore.getState().timeline,
        [`clip-${body}`]: {
          filetype: "text",
          startTime: 0,
          duration: 2000,
          location: { x: 100, y: 100 },
          width: 400,
          height: 80,
          text: body,
          textcolor: "#ffffff",
          fontsize: 52,
          fontpath: "",
          fontname: "",
          fontweight: "normal",
          fontstyle: "normal",
          align: "left",
          letterSpacing: 0,
          options: { isBold: false, isItalic: false, align: "left" },
          priority: 1,
          opacity: 100,
          rotation: 0,
          animation: {},
        },
      },
    });
  }, text);
}

test("a successful save retires the project's recovery ring", async ({
  session,
  artifactDir,
}) => {
  const { page, answerSaveDialog, userDataDir } = session;
  const file = path.join(artifactDir, "retire.ngt");

  await test.step("an edit lands in the cache", async () => {
    await addClip(page, "one");

    // 5s idle debounce, so this is a real wait rather than a poll artefact.
    await expect
      .poll(() => entries(userDataDir).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
  });

  await test.step("saving the project empties it", async () => {
    // Requirement, verbatim: "사용자가 프로젝트를 저장했다면 해당 캐시는 삭제되어야 해".
    await answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    await expect
      .poll(() => entries(userDataDir).length, { timeout: 30_000 })
      .toBe(0);
  });

  await test.step("a further edit starts a new ring under the file's key", async () => {
    await addClip(page, "two");
    await expect
      .poll(() => rings(userDataDir).filter((k) => k.startsWith("f-")).length, {
        timeout: 30_000,
      })
      .toBe(1);
  });
});

test("no autosave is written for a project nobody has touched", async ({
  session,
}) => {
  const { userDataDir } = session;

  // The decline path, end to end: an untouched project matches its baseline,
  // so nothing is written at all. If this ever starts writing, the "the menu
  // is empty means everything is saved" invariant is gone.
  await new Promise((resolve) => setTimeout(resolve, 12_000));
  expect(entries(userDataDir)).toEqual([]);
});

test("work survives a kill, and recovery leaves the original alone", async ({
  session,
  artifactDir,
}) => {
  const { page, answerSaveDialog, userDataDir } = session;
  const file = path.join(artifactDir, "crash.ngt");

  await test.step("save a project, then edit it", async () => {
    await addClip(page, "saved");
    await answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    // The ring is retired by the save, so what follows is the divergence only.
    await expect
      .poll(() => entries(userDataDir).length, { timeout: 30_000 })
      .toBe(0);

    await addClip(page, "unsaved");
    await expect
      .poll(() => entries(userDataDir).length, { timeout: 30_000 })
      .toBe(1);
  });

  const savedBytes = fs.readFileSync(file);

  await test.step("kill the app, with no graceful close", async () => {
    // `app.exit(0)` rather than `close()`: the disaster this feature exists
    // for is not a tidy quit. Nothing gets a chance to flush.
    await session.app.evaluate(({ app }) => app.exit(0));
  });

  await test.step("relaunch into the same cache and recover", async () => {
    const second = await launchApp({ userDataDir });
    try {
      // The entry is still there after a hard kill, because it was renamed
      // into place rather than written in situ.
      expect(entries(userDataDir)).toHaveLength(1);

      // The submenu names it. Read through Electron rather than by clicking,
      // because a native menu is not in the page.
      const labels = await second.app.evaluate(({ Menu }) => {
        const file = Menu.getApplicationMenu()?.items.find(
          (item) => item.label === "File",
        );
        const autoSave = file?.submenu?.items.find(
          (item) => item.label === "Auto Save",
        );
        return {
          enabled: autoSave?.enabled ?? null,
          projects:
            autoSave?.submenu?.items.map((item) => ({
              label: item.label,
              entries: item.submenu?.items.map((e) => e.label) ?? [],
            })) ?? [],
        };
      });

      expect(labels.enabled).toBe(true);
      expect(labels.projects).toHaveLength(1);
      expect(labels.projects[0].label).toBe("crash.ngt");
      expect(labels.projects[0].entries).toHaveLength(1);
      expect(labels.projects[0].entries[0]).toMatch(/^Today \d\d:\d\d:\d\d$/);

      // Click the entry, the way a user would.
      await clickFirstRecoveryPoint(second.app);

      await test.step("the work comes back", async () => {
        await expect
          .poll(
            async () =>
              second.page.evaluate(
                () =>
                  Object.keys(
                    (globalThis as any).CARTCUT.useTimelineStore.getState()
                      .timeline,
                  ).length,
              ),
            { timeout: 30_000 },
          )
          .toBe(2);
      });

      await test.step("the session is detached, so ⌘S cannot overwrite it", async () => {
        // The single sharpest hazard in the feature: a recovered session that
        // adopted the original path would have the next ⌘S write recovered
        // older state over the user's file.
        const held = await second.page.evaluate(
          () =>
            (document.querySelector("#projectFile") as HTMLInputElement | null)
              ?.value ?? null,
        );
        expect(held).toBe("");
      });

      await test.step("the original .ngt is byte-identical", async () => {
        expect(fs.readFileSync(file).equals(savedBytes)).toBe(true);
      });

      await test.step("the ring it came from survives", async () => {
        // Recovery is read-only on the cache. A user who picked the wrong
        // entry must not have destroyed the right one by looking at it.
        expect(entries(userDataDir)).toHaveLength(1);
      });
    } finally {
      await second.close();
    }
  });
});

/** Click the first recovery point in File ▸ Auto Save, through the real menu. */
async function clickFirstRecoveryPoint(app: any): Promise<void> {
  await app.evaluate(({ Menu }: any) => {
    const file = Menu.getApplicationMenu()?.items.find(
      (item: any) => item.label === "File",
    );
    const autoSave = file?.submenu?.items.find(
      (item: any) => item.label === "Auto Save",
    );
    const entry = autoSave?.submenu?.items[0]?.submenu?.items[0];
    if (entry == null) {
      throw new Error("File ▸ Auto Save offered no recovery point");
    }
    entry.click();
  });
}

test("recovery refuses a timeline that has anything on it", async ({
  session,
  artifactDir,
}) => {
  const { page, app, answerSaveDialog, userDataDir } = session;
  const file = path.join(artifactDir, "refuse.ngt");

  await test.step("save a project, then edit it so a ring exists", async () => {
    await addClip(page, "one");
    await answerSaveDialog(file);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect.poll(() => fs.existsSync(file), { timeout: 30_000 }).toBe(true);

    await addClip(page, "two");
    await expect
      .poll(() => entries(userDataDir).length, { timeout: 30_000 })
      .toBe(1);
  });

  await test.step("it refuses, and changes nothing", async () => {
    const before = await page.evaluate(() =>
      JSON.stringify(
        (globalThis as any).CARTCUT.useTimelineStore.getState().timeline,
      ),
    );

    await clickFirstRecoveryPoint(app);

    // The refusal modal carries the reason. Requirement: "만약 현재 타임라인에
    // 뭔가 있다면 불러오지 말고 경고를 띄워."
    await expect(page.locator("#whenTimelineChangedMsg")).toContainText(
      "already an edit open",
      { timeout: 10_000 },
    );

    const after = await page.evaluate(() =>
      JSON.stringify(
        (globalThis as any).CARTCUT.useTimelineStore.getState().timeline,
      ),
    );
    expect(after).toBe(before);
  });

  await test.step("and the recovery point it refused is still there", async () => {
    expect(entries(userDataDir)).toHaveLength(1);
  });
});
