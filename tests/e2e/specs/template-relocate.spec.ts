/**
 * A project folder has to survive being carried somewhere else.
 *
 * The unit suites prove the two functions round-trip
 * (`features/project/assetPaths.test.ts`, `assetsFile.test.ts`). This proves
 * the app actually calls them: a relative path reaches `assetPaths.json` inside
 * the real `.ngt` zip, and the real load path prefers it over the absolute one
 * that `timeline.json` still carries.
 *
 * The move is faked the way `project-roundtrip.spec.ts` fakes an old project —
 * by rewriting the archive the app just wrote. Copying the folder is not
 * enough on its own: the original is still on disk, so the *absolute* path
 * would resolve and the test would pass without the feature existing at all.
 * So the copy's `timeline.json` gets an absolute path that leads nowhere, and
 * the only way the clip can come back is the relative one.
 *
 * The clip that lives outside the project folder is the control. It must be
 * left exactly as it was — no `../`, no rewriting — and counted as missing.
 */

import fs from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import { test, expect } from "../harness/test";
import { agent, timelineDocument } from "../harness/agent";
import { setDuration, setResolution } from "../harness/ui";

/** Read one JSON entry out of a written `.ngt`. */
async function entryIn(file: string, name: string): Promise<any> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const entry = zip.file(name);
  return entry ? JSON.parse(await entry.async("string")) : null;
}

/** Rewrite one JSON entry inside a `.ngt`, in place. */
async function rewriteEntry(
  file: string,
  name: string,
  fn: (value: any) => any,
): Promise<void> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const current = JSON.parse(await zip.file(name)!.async("string"));
  zip.file(name, JSON.stringify(fn(current)));
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
}

/** Every element's localpath, keyed by element id. */
async function localpaths(session: any): Promise<Record<string, string>> {
  const document = await timelineDocument(session);
  const out: Record<string, string> = {};
  for (const [id, element] of Object.entries<any>(document)) {
    out[id] = element.localpath;
  }
  return out;
}

test("a project folder carried elsewhere finds its media again", async ({
  session,
  fixtures,
  artifactDir,
}) => {
  const { page, answerSaveDialog, answerOpenDialog } = session;

  // The project folder, and a second one standing in for another machine.
  const home = path.join(artifactDir, "home");
  const away = path.join(artifactDir, "away");
  const outside = path.join(artifactDir, "outside");
  fs.mkdirSync(path.join(home, "clips"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const source = fixtures.video[0].path;
  const insideClip = path.join(home, "clips", "inside.mp4");
  const outsideClip = path.join(outside, "outside.mp4");
  fs.copyFileSync(source, insideClip);
  fs.copyFileSync(source, outsideClip);

  const homeProject = path.join(home, "promo.ngt");
  let insideId = "";
  let outsideId = "";

  await test.step("build a project with one clip in the folder and one outside", async () => {
    await setResolution(page, 640, 360);
    await setDuration(page, 5);

    const inside = await agent<any>(session, "add_media", {
      items: [{ path: insideClip }],
      startMs: 0,
      sequential: false,
    });
    expect(inside.skipped ?? []).toEqual([]);
    insideId = inside.created[0];

    const out = await agent<any>(session, "add_media", {
      items: [{ path: outsideClip }],
      startMs: 0,
      sequential: false,
    });
    expect(out.skipped ?? []).toEqual([]);
    outsideId = out.created[0];
  });

  await test.step("save it", async () => {
    await answerSaveDialog(homeProject);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.save());
    await expect
      .poll(() => fs.existsSync(homeProject), { timeout: 30_000 })
      .toBe(true);
  });

  await test.step("the in-folder clip is recorded relative, the outside one is not", async () => {
    const assets = await entryIn(homeProject, "assetPaths.json");
    expect(assets).not.toBeNull();

    // POSIX separators, whatever platform wrote it — that is what makes the
    // file readable on the other one.
    expect(assets.entries[insideId].localpath.rel).toBe("clips/inside.mp4");
    expect(assets.entries[outsideId]).toBeUndefined();

    // And `timeline.json` still carries absolute paths, so an older build
    // opens this file exactly as it always did.
    const timeline = await entryIn(homeProject, "timeline.json");
    expect(timeline[insideId].localpath).toContain("home");
    expect(timeline[outsideId].localpath).toContain("outside");
  });

  await test.step("carry the folder to another machine", async () => {
    fs.cpSync(home, away, { recursive: true });

    // Break the absolute paths in the copy. Without this the original folder
    // is still on disk and the absolute path would resolve, so the test would
    // pass whether or not any of this feature worked.
    await rewriteEntry(
      path.join(away, "promo.ngt"),
      "timeline.json",
      (timeline) => {
        timeline[insideId].localpath = timeline[insideId].localpath.replace(
          "/home/",
          "/gone/",
        );
        return timeline;
      },
    );
    // The recorded `abs` has to keep matching, or the load-time consistency
    // check correctly refuses the relative path.
    await rewriteEntry(
      path.join(away, "promo.ngt"),
      "assetPaths.json",
      (assets) => {
        assets.entries[insideId].localpath.abs = assets.entries[
          insideId
        ].localpath.abs.replace("/home/", "/gone/");
        return assets;
      },
    );

    // The outside clip is genuinely gone on this "machine".
    fs.rmSync(outside, { recursive: true, force: true });
  });

  await test.step("open the copy — the in-folder clip comes back", async () => {
    await answerOpenDialog([path.join(away, "promo.ngt")]);
    await page.evaluate(() => (globalThis as any).CARTCUT.project.load());

    await expect
      .poll(async () => (await localpaths(session))[insideId], {
        timeout: 30_000,
      })
      .toContain(path.join("away", "clips", "inside.mp4"));

    const paths = await localpaths(session);

    // Relinked into the folder it was opened from, and pointing at a file
    // that is really there.
    expect(paths[insideId]).not.toContain("gone");
    const resolved = paths[insideId].replace(/^file:\/\//i, "");
    expect(fs.existsSync(resolved)).toBe(true);

    // The control: outside the folder, so never relativized and never
    // rewritten — left exactly as it was, pointing at what is now missing.
    expect(paths[outsideId]).toContain("outside");
  });
});
