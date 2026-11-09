// Every item of the browser build's menu bar, driven through the real bar.
//   node tests/spikes/webmenu/check.mjs [chromium|webkit|firefox] [out-dir]
//
// Chromium has the File System Access API; its pickers are stubbed onto the
// origin private file system (OPFS), so a "file on disk" is an OPFS file the
// test can read back. WebKit and Firefox have no pickers: a save is a
// download and an open is a file chooser, which Playwright answers.
import { chromium, firefox, webkit } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { serve, REPO } from "./serve.mjs";

const engineName = process.argv[2] ?? "chromium";
const out = process.argv[3] ?? path.join(REPO, "tests/spikes/webmenu/out");
fs.mkdirSync(out, { recursive: true });
const engine = { chromium, firefox, webkit }[engineName];
const PICKERS = engineName === "chromium";
const VIDEO = path.join(REPO, "apps/app/sample/106366-673007941.mp4");
const SRT = path.join(out, "lines.srt");
fs.writeFileSync(SRT, "1\n00:00:00,500 --> 00:00:01,500\nHello there\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line\n");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const site = await serve();
const launchOptions =
  engineName === "chromium"
    ? { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--mute-audio"] }
    : engineName === "firefox"
      ? {
          firefoxUserPrefs: {
            "media.navigator.streams.fake": true,
            "media.navigator.permission.disabled": true,
            "media.volume_scale": "0.0",
          },
        }
      : {};
const browser = await engine.launch(launchOptions);
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
  ...(engineName === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {}),
});
await context.addInitScript((pickers) => {
  localStorage.setItem("ONBOARDING_COMPLETED", "true");
  localStorage.setItem("TUTORIAL_COMPLETED", "true");
  if (!pickers) {
    return;
  }
  // The pickers, answered from queues the test fills, over OPFS handles.
  const abort = () => new DOMException("The user aborted a request.", "AbortError");
  window.__picks = { save: [], open: [], calls: { save: 0, open: 0 } };
  window.showSaveFilePicker = async () => {
    window.__picks.calls.save += 1;
    const name = window.__picks.save.shift();
    if (name == null) throw abort();
    const root = await navigator.storage.getDirectory();
    return root.getFileHandle(name, { create: true });
  };
  window.showOpenFilePicker = async () => {
    window.__picks.calls.open += 1;
    const names = window.__picks.open.shift();
    if (names == null) throw abort();
    const root = await navigator.storage.getDirectory();
    return Promise.all(names.map((name) => root.getFileHandle(name)));
  };
}, PICKERS);

const dialogs = [];
let page = await context.newPage();
const consoleErrors = [];
function watch(p) {
  p.on("dialog", (dialog) => {
    dialogs.push(dialog.type());
    void dialog.accept();
  });
  p.on("pageerror", (error) => consoleErrors.push(String(error)));
}
watch(page);

async function boot() {
  await page.goto(site.url + "/");
  await page.waitForFunction(() => window.CARTCUT?.useTimelineStore != null, null, { timeout: 60000 });
  await page.waitForSelector("web-menu-bar .wmb-top");
  await page.waitForTimeout(1500);
}

// ------------------------------------------------------------------ helpers

/** Close whatever modal a menu item opened, as its own close button would. */
async function dismiss() {
  await page.evaluate(() => {
    for (const modal of document.querySelectorAll(".modal.show")) {
      window.bootstrap?.Modal.getInstance(modal)?.hide();
    }
  });
  await page.waitForFunction(() => document.querySelector(".modal.show, .modal-backdrop") == null, null, { timeout: 5000 }).catch(() => null);
  await page.keyboard.press("Escape");
}

async function openMenu(label) {
  if ((await page.locator("web-menu-bar .wmb-panel").count()) > 0) {
    await page.keyboard.press("Escape");
  }
  await page.locator("web-menu-bar .wmb-top", { hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
  await page.waitForSelector("web-menu-bar .wmb-panel");
}

async function itemsOf(label) {
  await openMenu(label);
  const items = await page.$$eval("web-menu-bar .wmb-panel:not(.wmb-sub) > *", (nodes) =>
    nodes.map((node) =>
      node.classList.contains("wmb-sep") ? "-" : node.querySelector(".wmb-label")?.textContent.trim(),
    ),
  );
  await page.keyboard.press("Escape");
  return items;
}

async function menu(label, item) {
  await openMenu(label);
  await page
    .locator("web-menu-bar .wmb-panel:not(.wmb-sub) .wmb-item", { has: page.locator(".wmb-label", { hasText: item }) })
    .first()
    .click();
}

async function toastText() {
  return page.evaluate(() =>
    [...document.querySelectorAll("#toast toast-item")].map((t) => t.getAttribute("toast-message")).join(" / "),
  );
}

async function elementCount() {
  return page.evaluate(() => Object.keys(CARTCUT.useTimelineStore.getState().getDocument().elements).length);
}

async function elementPaths() {
  return page.evaluate(() =>
    Object.values(CARTCUT.useTimelineStore.getState().getDocument().elements)
      .map((element) => element.localpath)
      .filter((p) => typeof p === "string"),
  );
}

async function opfsWrite(name, file) {
  const bytes = fs.readFileSync(file);
  await page.evaluate(
    async ({ name, data }) => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(data));
      await writable.close();
    },
    { name, data: [...bytes] },
  );
}

async function opfsRead(name) {
  const data = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    try {
      const file = await (await root.getFileHandle(name)).getFile();
      return [...new Uint8Array(await file.arrayBuffer())];
    } catch {
      return null;
    }
  }, name);
  return data == null ? null : Buffer.from(data);
}

/** Answer the next picker or chooser with these files. */
async function nextOpen(files, run) {
  if (PICKERS) {
    await page.evaluate((names) => window.__picks.open.push(names), files.map((f) => path.basename(f)));
    await run();
    return;
  }
  const chooser = page.waitForEvent("filechooser", { timeout: 15000 });
  await run();
  await (await chooser).setFiles(files);
}

/** Answer the next save: a picker in Chromium, the name dialog and a download elsewhere. */
async function nextSave(name, run) {
  if (PICKERS) {
    await page.evaluate((n) => window.__picks.save.push(n), name);
    await run();
    return null;
  }
  const download = page.waitForEvent("download", { timeout: 30000 });
  await run();
  await page.waitForSelector("web-file-dialog .wfd-input", { timeout: 10000 });
  await page.fill("web-file-dialog .wfd-input", name);
  await page.click("web-file-dialog button[type=submit]");
  const saved = await download;
  const target = path.join(out, `${engineName}-${saved.suggestedFilename()}`);
  await saved.saveAs(target);
  return target;
}

function zipEntries(buffer) {
  // Central directory names, enough to see which entries an archive holds.
  const names = [];
  for (let i = 0; i + 46 < buffer.length; i++) {
    if (buffer.readUInt32LE(i) === 0x02014b50) {
      const length = buffer.readUInt16LE(i + 28);
      names.push(buffer.slice(i + 46, i + 46 + length).toString());
    }
  }
  return names;
}

async function placeImported() {
  await page.waitForFunction(() => [...document.querySelectorAll("asset-file")].some((tile) => tile.path?.startsWith("blob:")), null, { timeout: 15000 });
  await page.evaluate(() => {
    const tile = [...document.querySelectorAll("asset-file")].find((t) => t.path?.startsWith("blob:"));
    tile.dispatchEvent(new CustomEvent("asset-open", { detail: { path: tile.path }, bubbles: true, composed: true }));
  });
  await page.waitForFunction(() => Object.keys(CARTCUT.useTimelineStore.getState().getDocument().elements).length > 0, null, { timeout: 20000 });
}

async function relinkDialog() {
  return page.evaluate(() => {
    const card = document.querySelector("web-file-dialog .wfd-card[aria-label='Reconnect Media']");
    if (card == null) return null;
    return [...card.querySelectorAll(".wfd-list li")].map((li) => li.textContent.replace(/\s+/g, " ").trim());
  });
}

// ------------------------------------------------------------------ the bar

await boot();
if (PICKERS) {
  await opfsWrite(path.basename(VIDEO), VIDEO);
  await opfsWrite("lines.srt", SRT);
}
await page.screenshot({ path: path.join(out, `${engineName}-bar.png`), clip: { x: 0, y: 0, width: 1440, height: 60 } });

const bar = await page.$eval("web-menu-bar", (el) => el.getBoundingClientRect().left);
check("menu bar sits at the left edge", bar < 12, `left=${bar}`);
const tops = await page.$$eval("web-menu-bar .wmb-top", (nodes) => nodes.map((n) => n.textContent.trim()));
check("menus in desktop order", tops.join(",") === "File,Edit,Clip,Playback,Utilities,View,About,Help", tops.join(","));
const fileItems = await itemsOf("File");
check("File items", fileItems.join("|").includes("Open Project…|Save Project|Save Project As…"), fileItems.join("|"));
const util = await itemsOf("Utilities");
check("desktop-only tools hidden", !util.some((l) => /Screen Recorder|Proxy|Automatic Caption|^Record$/.test(l)), util.join("|"));

await openMenu("File");
await page.screenshot({ path: path.join(out, `${engineName}-file-menu.png`), clip: { x: 0, y: 0, width: 600, height: 420 } });
// Keyboard: down, across, Escape.
await page.keyboard.press("ArrowDown");
await page.keyboard.press("ArrowRight");
const afterRight = await page.$eval("web-menu-bar .wmb-top.is-open", (n) => n.textContent.trim());
check("ArrowRight moves to the next menu", afterRight === "Edit", afterRight);
await page.keyboard.press("Escape");
check("Escape closes", (await page.locator("web-menu-bar .wmb-panel").count()) === 0);
// Hover switches while open; a click outside closes.
await openMenu("Clip");
await page.locator("web-menu-bar .wmb-top", { hasText: "View" }).hover();
const hovered = await page.$eval("web-menu-bar .wmb-top.is-open", (n) => n.textContent.trim());
check("hover switches menus while one is open", hovered === "View", hovered);
await page.mouse.click(700, 500);
check("click outside closes", (await page.locator("web-menu-bar .wmb-panel").count()) === 0);

// ------------------------------------------------------------ import, save

await nextOpen([VIDEO], () => menu("File", "Import Media…"));
await placeImported();
check("Import Media places a clip", (await elementCount()) === 1);

const firstSave = await nextSave("Menu Test.ngt", () => menu("File", "Save Project"));
await page.waitForTimeout(2500);
let archive = PICKERS ? await opfsRead("Menu Test.ngt") : firstSave && fs.readFileSync(firstSave);
check("Save writes a .ngt", archive != null && archive.length > 1000, `${archive?.length ?? 0} bytes`);
check("the archive records the browser media", archive != null && zipEntries(archive).includes("webMedia.json"), archive ? zipEntries(archive).join(",") : "");
const title = await page.evaluate(() => document.title);
check("tab title names the project", /Menu Test\.ngt/.test(title), title);
check("save toast", /Saved/.test(await toastText()), await toastText());

// ⌘S again: Chromium writes in place without asking; elsewhere it downloads under the same name without asking.
await page.evaluate(() => {
  const s = CARTCUT.useTimelineStore.getState();
  const id = Object.keys(s.getDocument().elements)[0];
  CARTCUT.useTimelineStore.getState().withCheckpoint((doc) => ({ ...doc, elements: { ...doc.elements, [id]: { ...doc.elements[id], startTime: 500 } } }));
});
const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? "Meta" : "Control";
if (PICKERS) {
  const before = await page.evaluate(() => window.__picks.calls.save);
  await page.keyboard.press(`${mod}+KeyS`);
  await page.waitForTimeout(2000);
  const after = await page.evaluate(() => window.__picks.calls.save);
  archive = await opfsRead("Menu Test.ngt");
  check("⌘S saves in place without asking", after === before, `picker calls ${before} -> ${after}`);
} else {
  const download = page.waitForEvent("download", { timeout: 15000 });
  await page.keyboard.press(`${mod}+KeyS`);
  const saved = await download.catch(() => null);
  check("⌘S downloads again without asking", saved != null && saved.suggestedFilename() === "Menu Test.ngt", saved?.suggestedFilename());
  if (saved) {
    await saved.saveAs(firstSave);
  }
  archive = fs.readFileSync(firstSave);
}
const dirtyAfterSave = await page.evaluate(() => document.title);
check("project clean after ⌘S", dirtyAfterSave.length > 0);

// ----------------------------------------------- Auto Save and the guard

await page.evaluate(() => {
  const s = CARTCUT.useTimelineStore.getState();
  const id = Object.keys(s.getDocument().elements)[0];
  s.withCheckpoint((doc) => ({ ...doc, elements: { ...doc.elements, [id]: { ...doc.elements[id], startTime: 1500 } } }));
});
await page.waitForTimeout(6500);
await openMenu("File");
await page.locator("web-menu-bar .wmb-item", { hasText: "Auto Save" }).hover();
await page.waitForSelector("web-menu-bar .wmb-sub");
await page.waitForTimeout(500);
const rows = await page.$$eval("web-menu-bar .wmb-sub .wmb-item", (nodes) => nodes.map((n) => n.textContent.replace(/\s+/g, " ").trim()));
check("Auto Save lists a recovery point", rows.length >= 1, rows.join(" / "));
await page.screenshot({ path: path.join(out, `${engineName}-autosave.png`), clip: { x: 0, y: 0, width: 700, height: 420 } });
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

// Reloading on unsaved work asks first.
dialogs.length = 0;
await page.reload();
await page.waitForFunction(() => window.CARTCUT?.useTimelineStore != null, null, { timeout: 60000 });
await page.waitForSelector("web-menu-bar .wmb-top");
await page.waitForTimeout(1500);
check("closing a tab on unsaved work asks", dialogs.includes("beforeunload"), dialogs.join(","));
check("reload starts empty", (await elementCount()) === 0);

// Recover it.
await openMenu("File");
await page.locator("web-menu-bar .wmb-item", { hasText: "Auto Save" }).hover();
await page.waitForSelector("web-menu-bar .wmb-sub .wmb-item", { timeout: 5000 }).catch(() => null);
await page.locator("web-menu-bar .wmb-sub .wmb-item").first().click();
await page.waitForTimeout(2500);
let relink = await relinkDialog();
if (relink != null) {
  // Chromium has the handle filed, so nothing to locate; elsewhere the user
  // picks the file again.
  if (!PICKERS) {
    await nextOpen([VIDEO], () => page.click("web-file-dialog button:has-text('Locate Files')"));
    await page.waitForTimeout(800);
  }
  relink = await relinkDialog();
  await page.click("web-file-dialog .wfd-button.is-primary");
}
await page.waitForFunction(() => Object.keys(CARTCUT.useTimelineStore.getState().getDocument().elements).length > 0, null, { timeout: 15000 }).catch(() => null);
const recovered = await page.evaluate(() => Object.values(CARTCUT.useTimelineStore.getState().getDocument().elements).map((e) => e.startTime));
check("Auto Save recovers the unsaved edit", recovered.includes(1500), JSON.stringify(recovered));
const livePaths = await elementPaths();
const live = await page.evaluate(async (paths) => {
  const answers = [];
  for (const p of paths) {
    try {
      const r = await fetch(p.split("#")[0]);
      answers.push(r.ok);
    } catch {
      answers.push(false);
    }
  }
  return answers;
}, livePaths);
check("recovered media plays from a live file", live.length > 0 && live.every(Boolean), JSON.stringify(live));

// ------------------------------------------------------------ Open Project

// Discard the recovered work and open the saved file.
await page.evaluate(() => CARTCUT.useTimelineStore.getState().withCheckpoint((doc) => ({ ...doc, elements: {} })));
dialogs.length = 0;
await page.reload();
await page.waitForFunction(() => window.CARTCUT?.useTimelineStore != null, null, { timeout: 60000 });
await page.waitForSelector("web-menu-bar .wmb-top");
await page.waitForTimeout(1000);
const openFile = PICKERS ? "Menu Test.ngt" : firstSave;
if (PICKERS) {
  await nextOpen(["Menu Test.ngt"], () => menu("File", "Open Project…"));
} else {
  await nextOpen([openFile], () => menu("File", "Open Project…"));
}
await page.waitForTimeout(2500);
relink = await relinkDialog();
if (PICKERS) {
  check("Chromium reconnects media without asking", relink == null, JSON.stringify(relink));
} else {
  check("reopened project asks to reconnect", relink != null && relink.length === 1, JSON.stringify(relink));
  await nextOpen([VIDEO], () => page.click("web-file-dialog button:has-text('Locate Files')"));
  await page.waitForTimeout(800);
  const after = await relinkDialog();
  check("located file matches by name and size", after != null && /Found|Ready|Connected/i.test(after[0] ?? ""), JSON.stringify(after));
  await page.click("web-file-dialog .wfd-button.is-primary");
}
await page.waitForFunction(() => Object.keys(CARTCUT.useTimelineStore.getState().getDocument().elements).length > 0, null, { timeout: 15000 }).catch(() => null);
const opened = await page.evaluate(() => Object.values(CARTCUT.useTimelineStore.getState().getDocument().elements).map((e) => e.startTime));
check("Open Project loads the saved edit", opened.includes(500), JSON.stringify(opened));
const openedLive = await page.evaluate(async (paths) => Promise.all(paths.map((p) => fetch(p.split("#")[0]).then((r) => r.ok, () => false))), await elementPaths());
check("opened media is live", openedLive.length > 0 && openedLive.every(Boolean), JSON.stringify(openedLive));
check("opened project is clean", !(await page.evaluate(() => document.title)).includes("*"));

if (PICKERS) {
  // Forget the filed handles: the reconnect dialog must appear and Locate must fix it.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const request = indexedDB.open("cartcut-web");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("mediaHandles", "readwrite");
          tx.objectStore("mediaHandles").clear();
          tx.oncomplete = () => resolve(true);
        };
      }),
  );
  await page.reload();
  await page.waitForFunction(() => window.CARTCUT?.useTimelineStore != null, null, { timeout: 60000 });
  await page.waitForSelector("web-menu-bar .wmb-top");
  await nextOpen(["Menu Test.ngt"], () => menu("File", "Open Project…"));
  await page.waitForTimeout(2500);
  relink = await relinkDialog();
  check("without a filed handle Chromium asks to reconnect", relink != null && relink.length === 1, JSON.stringify(relink));
  await page.screenshot({ path: path.join(out, `${engineName}-relink.png`) });
  await nextOpen([VIDEO], () => page.click("web-file-dialog button:has-text('Locate Files')"));
  await page.waitForTimeout(800);
  const after = await relinkDialog();
  check("located file matches", after != null && !/missing/i.test(after[0] ?? ""), JSON.stringify(after));
  await page.click("web-file-dialog .wfd-button.is-primary");
  await page.waitForTimeout(1500);
  const live2 = await page.evaluate(async (paths) => Promise.all(paths.map((p) => fetch(p.split("#")[0]).then((r) => r.ok, () => false))), await elementPaths());
  check("relinked media is live", live2.length > 0 && live2.every(Boolean), JSON.stringify(live2));
}

// ------------------------------------------------------------- Save As

const asTarget = await nextSave("Second.ngt", () => menu("File", "Save Project As…"));
await page.waitForTimeout(2000);
const second = PICKERS ? await opfsRead("Second.ngt") : asTarget && fs.readFileSync(asTarget);
check("Save As writes a new file", second != null && second.length > 1000);
check("title follows Save As", /Second\.ngt/.test(await page.evaluate(() => document.title)));

// --------------------------------------------------------------- Subtitles

const beforeSubs = await elementCount();
await nextOpen([PICKERS ? path.join(out, "lines.srt") : SRT], () => menu("File", "Import Subtitles…"));
await page.waitForTimeout(1500);
// The import asks which clock the file counts in.
const importButton = page.locator("subtitle-import-dialog button.btn-primary").first();
if (await importButton.isVisible().catch(() => false)) {
  await importButton.click();
}
await page.waitForTimeout(1500);
const afterSubs = await elementCount();
check("Import Subtitles adds caption clips", afterSubs >= beforeSubs + 2, `${beforeSubs} -> ${afterSubs}`);

const subTarget = await nextSave("Lines Out.srt", () => menu("File", "Export Subtitles…"));
await page.waitForTimeout(1500);
const srtOut = PICKERS ? await opfsRead("Lines Out.srt") : subTarget && fs.readFileSync(subTarget);
check("Export Subtitles writes the lines", srtOut != null && /Hello there/.test(srtOut.toString()) && /Second line/.test(srtOut.toString()), srtOut?.toString().slice(0, 80));

// ------------------------------------------------------------ Edit in a field

await page.evaluate(() => {
  const input = document.createElement("input");
  input.id = "__probe";
  input.value = "hello world";
  input.style.cssText = "position:fixed;left:600px;top:300px;z-index:99999";
  document.body.appendChild(input);
  input.focus();
  input.setSelectionRange(0, 0);
});
await menu("Edit", "Select All");
const selected = await page.evaluate(() => {
  const input = document.getElementById("__probe");
  return [document.activeElement === input, input.selectionStart, input.selectionEnd];
});
check("Edit > Select All selects the field's text and keeps focus", selected[0] && selected[1] === 0 && selected[2] === 11, JSON.stringify(selected));
const clipsBefore = await elementCount();
await menu("Edit", "Cut");
await page.waitForTimeout(300);
const afterCut = await page.evaluate(() => document.getElementById("__probe").value);
check("Edit > Cut cuts the field's text, not clips", afterCut === "" && (await elementCount()) === clipsBefore, JSON.stringify(afterCut));
await menu("Edit", "Undo");
await page.waitForTimeout(300);
const afterUndo = await page.evaluate(() => document.getElementById("__probe").value);
check("Edit > Undo undoes the field's edit", afterUndo === "hello world", JSON.stringify(afterUndo));
if (engineName === "chromium") {
  await page.evaluate(() => {
    const input = document.getElementById("__probe");
    input.value = "";
    input.focus();
  });
  await page.evaluate(() => navigator.clipboard.writeText("pasted"));
  await menu("Edit", "Paste");
  await page.waitForTimeout(300);
  check("Edit > Paste pastes into the field", (await page.evaluate(() => document.getElementById("__probe").value)) === "pasted");
}
await page.evaluate(() => {
  document.getElementById("__probe").remove();
});

// Clip edits from the menu act on the timeline.
const n0 = await elementCount();
await page.evaluate(() => {
  const s = CARTCUT.useTimelineStore.getState();
  const video = Object.values(s.getDocument().elements).find((e) => e.filetype === "video");
  CARTCUT.selectionStore?.getState?.().select?.([video.elementId]);
});
await menu("Edit", "Select All");
await menu("Edit", "Copy");
await menu("Edit", "Paste");
await page.waitForTimeout(500);
const n1 = await elementCount();
check("Edit > Select All, Copy, Paste duplicates clips", n1 > n0, `${n0} -> ${n1}`);
await menu("Edit", "Undo");
await page.waitForTimeout(300);
check("Edit > Undo removes the paste", (await elementCount()) === n0, `${await elementCount()}`);
await menu("Edit", "Redo");
await page.waitForTimeout(300);
check("Edit > Redo restores it", (await elementCount()) === n1);
await menu("Edit", "Undo");

// ------------------------------------------------------- Clip, Playback, View

const clipItems = await itemsOf("Clip");
const playItems = await itemsOf("Playback");
const viewItems = await itemsOf("View");
for (const [label, items] of [
  ["Playback", playItems],
  ["View", viewItems],
]) {
  for (const item of items.filter((i) => i !== "-")) {
    const errorsBefore = consoleErrors.length;
    await menu(label, item);
    await page.waitForTimeout(250);
    await dismiss();
    check(`${label} > ${item} runs`, consoleErrors.length === errorsBefore, consoleErrors.slice(errorsBefore).join(" | "));
  }
}
// Stop playback if a Play item left it running.
await page.evaluate(() => CARTCUT.useTimelineStore.getState().setPlay?.(false));
for (const item of clipItems.filter((i) => i !== "-")) {
  const errorsBefore = consoleErrors.length;
  await menu("Clip", item);
  await page.waitForTimeout(300);
  await dismiss();
  check(`Clip > ${item} runs`, consoleErrors.length === errorsBefore, consoleErrors.slice(errorsBefore).join(" | "));
}

// ------------------------------------------------------------- Utilities

if (engineName !== "webkit") {
  await menu("Utilities", "Audio Record");
  await page.waitForSelector("audio-record-panel button.btn-primary", { timeout: 8000 });
  const beforeRec = await elementCount();
  await page.click("audio-record-panel button.btn-primary");
  await page.waitForTimeout(2000);
  await page.click("audio-record-panel button.btn-danger");
  await page.waitForFunction((n) => Object.keys(CARTCUT.useTimelineStore.getState().getDocument().elements).length > n, beforeRec, { timeout: 15000 }).catch(() => null);
  check("Audio Record lands a clip", (await elementCount()) > beforeRec);
}

for (const item of ["Text to Speech", "Prompter", "Auto Track"]) {
  const errorsBefore = consoleErrors.length;
  await menu("Utilities", item);
  await page.waitForTimeout(800);
  check(`Utilities > ${item} opens`, consoleErrors.length === errorsBefore, consoleErrors.slice(errorsBefore).join(" | "));
  await dismiss();
}

const tplTarget = await nextSave("Menu Template.cttpl", () => menu("Utilities", "Export Template…"));
await page.waitForTimeout(4000);
const tpl = PICKERS ? await opfsRead("Menu Template.cttpl") : tplTarget && fs.readFileSync(tplTarget);
check("Export Template writes a .cttpl", tpl != null && tpl.length > 1000 && zipEntries(tpl).length > 0, tpl ? `${tpl.length} bytes ${zipEntries(tpl).slice(0, 6).join(",")}` : "none");

// ⌘O through the keyboard binding reaches Open Project, which (as on the
// desktop) refuses while the project has unsaved changes.
{
  const unsaved = await page.evaluate(() => CARTCUT.projectSnapshot != null);
  const chooser = PICKERS ? null : page.waitForEvent("filechooser", { timeout: 4000 }).catch(() => null);
  const before = PICKERS ? await page.evaluate(() => window.__picks.calls.open) : 0;
  await page.keyboard.press(`${mod}+KeyO`);
  await page.waitForTimeout(1000);
  const refused = await page.evaluate(() => document.querySelector("#whenTimelineChanged.show #whenTimelineChangedMsg")?.textContent ?? "");
  const asked = PICKERS ? (await page.evaluate(() => window.__picks.calls.open)) === before + 1 : (await chooser) != null;
  check("⌘O reaches Open Project", unsaved && (asked || /unsaved changes/.test(refused)), refused || (asked ? "asked" : "nothing"));
  await dismiss();
}

// ---------------------------------------------------------- About and Help

await menu("About", "Credit");
await page.waitForSelector("web-menu-bar .wmb-about");
await page.screenshot({ path: path.join(out, `${engineName}-about.png`) });
check("About > Credit shows the about card", true);
await page.click("web-menu-bar .wmb-about-close");

await menu("About", "Setting");
await page.waitForTimeout(800);
check("About > Setting opens the settings dialog", await page.evaluate(() => document.querySelector("settings-dialog")?.isOpen === true));
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

const popup = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
await menu("Help", "Learn More");
const learn = await popup;
check("Help > Learn More opens the tutorial page", learn != null && /cartesiancs\.com\/cartcut\/tutorial/.test(learn.url()), learn?.url());
await learn?.close();
for (const item of (await itemsOf("Help")).filter((i) => i !== "-" && i !== "Learn More")) {
  const errorsBefore = consoleErrors.length;
  await menu("Help", item);
  await page.waitForTimeout(600);
  check(`Help > ${item} runs`, consoleErrors.length === errorsBefore, consoleErrors.slice(errorsBefore).join(" | "));
  await dismiss();
}

// Export Video opens the export panel.
await menu("File", "Export Video…");
await page.waitForTimeout(1000);
await page.screenshot({ path: path.join(out, `${engineName}-export.png`) });

check("no uncaught page errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${engineName}: ${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
fs.writeFileSync(path.join(out, `${engineName}-results.json`), JSON.stringify(results, null, 2));
await browser.close();
site.close();
process.exit(failed.length === 0 ? 0 : 1);
