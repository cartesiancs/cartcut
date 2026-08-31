/**
 * Turning an installed LUT preset into a table the renderer can use.
 *
 * Sits between `fx/presetRegistry.ts`, which knows *where* every preset's file
 * is, and `renderer/lut/apply.ts`, which needs the parsed table synchronously
 * inside the paint loop.
 *
 * ## Lazy, because eighty tables is 7 MB
 *
 * `presetScan.ts` reports a `.cube` as a path and never reads its bytes, so
 * loading is this module's job and it happens on first use. A project that
 * grades nothing parses nothing.
 *
 * ## Synchronous reads, asynchronous loads
 *
 * `lutFor` is called from the paint loop and cannot await. On a miss it starts
 * the read and answers `null`, which draws the clip ungraded for that frame —
 * the same contract `compositor.ts#textureFor` has for a preset texture that
 * has not decoded yet, and the same one a video handle has before it seeks.
 * The preview repaints continuously, so the grade appears on the next frame.
 *
 * **An export cannot rely on that.** Its frame loop runs to completion in one
 * go, and a table that arrived on frame three would leave frames one and two
 * ungraded in the delivered file. `preloadLutsForDocument` exists for exactly
 * that, and `export/renderTimeline.ts` awaits it before the first frame. The
 * contact sheet does the same.
 *
 * ## Failures are remembered
 *
 * A file that will not parse is recorded once, with its message, and never
 * retried — a broken LUT must not mean a failed read on every frame for the
 * length of a render. `lutFailures()` is what the panel shows.
 */

import type { Timeline } from "../../@types/timeline";
import { presetById, presetsOfKind, subscribePresets } from "../fx/presetRegistry";
import type { FxPreset } from "../fx/presetTypes";
import { lutOf } from "../renderer/lut";
import { setLutResolver } from "../renderer/lut/apply";
import { isImageLutFilename, parseLutText, describeLutError } from "./parse";
import { parseImageLut } from "./haldImage";
import type { LutData } from "./lutData";

type Entry =
  | { state: "loading" }
  | { state: "ready"; lut: LutData }
  | { state: "failed"; message: string };

const entries = new Map<string, Entry>();

/** Everything installed, for the panel. Built-ins first, then by name. */
export function lutPresets(): FxPreset[] {
  return presetsOfKind("lut");
}

/**
 * The table for this preset, or `null` if it is not ready.
 *
 * `null` covers four different things and they all render the same: not
 * installed, not read yet, still reading, or unreadable. Distinguishing them
 * matters to the panel, not to the paint loop.
 */
export function lutFor(presetId: string): LutData | null {
  const entry = entries.get(presetId);
  if (entry != null) {
    return entry.state === "ready" ? entry.lut : null;
  }
  // Fire and forget. The next frame will find it.
  void loadLut(presetId);
  return null;
}

/** Read and parse one LUT, at most once. */
export async function loadLut(presetId: string): Promise<LutData | null> {
  const existing = entries.get(presetId);
  if (existing != null) {
    if (existing.state === "ready") {
      return existing.lut;
    }
    if (existing.state === "failed") {
      return null;
    }
    // Already in flight. Wait for it by polling the map on the microtask
    // queue rather than keeping a second promise per id: loads finish in
    // milliseconds and the alternative is a lifetime of promise bookkeeping
    // for a case only the preloader hits.
    return awaitEntry(presetId);
  }

  const preset = presetById(presetId);
  if (preset == null || preset.render.type !== "lut") {
    entries.set(presetId, {
      state: "failed",
      message: "no LUT preset with that id is installed",
    });
    return null;
  }

  const path = preset.assets[preset.render.source];
  if (path == null) {
    entries.set(presetId, {
      state: "failed",
      message: `the preset names \`${preset.render.source}\`, which is not in its folder`,
    });
    return null;
  }

  entries.set(presetId, { state: "loading" });
  try {
    const lut = isImageLutFilename(path)
      ? await readImageLut(path)
      : parseLutText(await readText(path), path);
    entries.set(presetId, { state: "ready", lut });
    return lut;
  } catch (error) {
    // Recorded rather than rethrown, and never retried: a broken LUT must not
    // cost a failed read on every frame of a four-thousand-frame render.
    entries.set(presetId, { state: "failed", message: describeLutError(error) });
    return null;
  }
}

async function awaitEntry(presetId: string): Promise<LutData | null> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const entry = entries.get(presetId);
    if (entry == null || entry.state === "failed") {
      return null;
    }
    if (entry.state === "ready") {
      return entry.lut;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

/**
 * Every LUT id a document refers to.
 *
 * Both ways a LUT reaches the screen: as a clip's own grade, and as the preset
 * behind an adjustment layer. An effect element's `presetId` may name a shader
 * preset instead, which `loadLut` rejects harmlessly.
 */
export function lutIdsIn(elements: Timeline): string[] {
  const ids = new Set<string>();
  for (const element of Object.values(elements)) {
    const ref = lutOf(element);
    if (ref != null) {
      ids.add(ref.presetId);
    }
    if (element.filetype === "effect") {
      const preset = presetById(element.presetId);
      if (preset != null && preset.render.type === "lut") {
        ids.add(element.presetId);
      }
    }
  }
  return [...ids];
}

/**
 * Read every LUT a document uses before anything draws it.
 *
 * The export's answer to lazy loading. Failures are swallowed — a LUT that
 * will not parse renders ungraded, which is what the missing-preset contract
 * promises everywhere else.
 */
export async function preloadLutsForDocument(elements: Timeline): Promise<void> {
  await Promise.all(lutIdsIn(elements).map((id) => loadLut(id)));
}

/** Load every installed LUT. Used by the panel to build its thumbnails. */
export async function preloadAllLuts(): Promise<void> {
  await Promise.all(lutPresets().map((preset) => loadLut(preset.id)));
}

/** LUTs that are installed but could not be read, for the panel to report. */
export function lutFailures(): Array<{ presetId: string; message: string }> {
  const out: Array<{ presetId: string; message: string }> = [];
  for (const [presetId, entry] of entries) {
    if (entry.state === "failed" && presetById(presetId) != null) {
      out.push({ presetId, message: entry.message });
    }
  }
  return out;
}

/**
 * Point the renderer at this registry, and keep it pointed.
 *
 * Called once at startup, next to `loadPresets()`. The subscription is what
 * makes an imported LUT usable without a restart: reinstalling a preset folder
 * changes what an id resolves to, so the cache for anything no longer present
 * is dropped and the next frame reads the new file.
 */
export function installLutResolver(): void {
  setLutResolver(lutFor);
  subscribePresets(() => {
    for (const presetId of [...entries.keys()]) {
      const preset = presetById(presetId);
      if (preset == null || preset.render.type !== "lut") {
        entries.delete(presetId);
      }
    }
  });
}

/** Test-only: forget every parsed table. */
export function resetLutRegistry(): void {
  entries.clear();
}

/** Test-only: put a table in directly, without touching the disk. */
export function setLutForTesting(presetId: string, lut: LutData): void {
  entries.set(presetId, { state: "ready", lut });
}

// ------------------------------------------------------------------- reading

type FilesystemBridge = {
  readFile?: (path: string) => Promise<unknown>;
};

function filesystem(): FilesystemBridge | null {
  const api = (
    globalThis as {
      electronAPI?: { req?: { filesystem?: FilesystemBridge } };
    }
  ).electronAPI;
  return api?.req?.filesystem ?? null;
}

async function readText(path: string): Promise<string> {
  const bridge = filesystem();
  if (bridge?.readFile == null) {
    throw new Error("no filesystem bridge — cannot read a LUT here");
  }
  const raw = await bridge.readFile(path);
  if (typeof raw === "string") {
    return raw;
  }
  // `filesystem:readFile` hands back a Node Buffer, which crosses the IPC
  // boundary as a `Uint8Array`. Decoding here rather than in the main process
  // keeps that handler a dumb byte reader, which is what everything else uses
  // it as.
  if (raw instanceof Uint8Array) {
    return new TextDecoder("utf-8").decode(raw);
  }
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(raw));
  }
  throw new Error("the LUT file could not be read as text");
}

/**
 * Decode an image LUT to pixels.
 *
 * Through an `<img>` and a canvas rather than by parsing PNG here: the browser
 * already has a decoder, and this is the only place in the LUT code that needs
 * a DOM — which is why `haldImage.ts` takes pixels rather than bytes and stays
 * node-testable.
 */
async function readImageLut(path: string) {
  if (typeof document === "undefined") {
    throw new Error("an image LUT needs a browser to decode it");
  }
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("the image could not be decoded"));
    element.src = path.startsWith("file://") ? path : `file://${path}`;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx == null) {
    throw new Error("no 2d context to decode the image LUT with");
  }
  ctx.drawImage(image, 0, 0);
  return parseImageLut(
    ctx.getImageData(0, 0, canvas.width, canvas.height),
  );
}
