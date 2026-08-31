/**
 * Bringing in a LUT the user already owns.
 *
 * The promise the whole feature rests on: hand Cartcut a `.cube` from any pack
 * and it grades the same way it does everywhere else. That means three things
 * have to happen in this order, and the order is the design:
 *
 *  1. **Read the bytes.** From the OS file dialog, or from a file dropped onto
 *     the panel.
 *  2. **Parse before writing anything.** A file that is not a LUT must be
 *     refused *here*, with the line number the reader found the problem on —
 *     not installed and then discovered to be broken the next time the panel
 *     tries to draw a thumbnail for it. That is the difference between "line
 *     412: a data row must hold exactly three numbers" and a tile that is
 *     mysteriously blank.
 *  3. **Install it as a preset folder.** Not into a registry of its own: the
 *     imported LUT then survives a restart, appears in search, is reachable as
 *     an adjustment layer and is deleted by deleting a folder — all of which
 *     the preset system already does, and none of which would exist in a
 *     parallel store.
 */

import { loadPresets } from "../fx/presetRegistry";
import { parseImageLut } from "./haldImage";
import type { LutData } from "./lutData";
import {
  LUT_FILE_EXTENSIONS,
  describeLutError,
  extensionOf,
  isImageLutFilename,
  parseLutText,
} from "./parse";

export type LutImportResult =
  | { ok: true; id: string; name: string; lut: LutData }
  | { ok: false; message: string };

type PresetBridge = {
  installLut?: (
    name: string,
    extension: string,
    bytes: Uint8Array,
  ) => Promise<{ id: string; dir: string }>;
};

type DialogBridge = {
  openFile?: (extensions: string[]) => Promise<string | string[] | null>;
};

type FilesystemBridge = {
  readFile?: (path: string) => Promise<unknown>;
};

function bridge<T>(key: "preset" | "dialog" | "filesystem"): T | null {
  const api = (
    globalThis as {
      electronAPI?: { req?: Record<string, unknown> };
    }
  ).electronAPI;
  return (api?.req?.[key] as T | undefined) ?? null;
}

/** The display name a file's own name suggests. */
export function lutNameFrom(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const withoutExtension = base.replace(/\.[^.]+$/, "");
  return withoutExtension.trim() === "" ? base : withoutExtension.trim();
}

/**
 * Open the file picker and import what comes back.
 *
 * `null` when the user cancelled, which is not a failure and must not toast.
 */
export async function pickAndImportLut(): Promise<LutImportResult | null> {
  const dialog = bridge<DialogBridge>("dialog");
  if (dialog?.openFile == null) {
    return { ok: false, message: "no file dialog is available here" };
  }
  const picked = await dialog.openFile([...LUT_FILE_EXTENSIONS]);
  const filePath = Array.isArray(picked) ? picked[0] : picked;
  if (filePath == null || filePath === "") {
    return null;
  }

  const filesystem = bridge<FilesystemBridge>("filesystem");
  if (filesystem?.readFile == null) {
    return { ok: false, message: "no filesystem bridge is available here" };
  }
  try {
    const raw = await filesystem.readFile(filePath);
    return await installFrom(lutNameFrom(filePath), filePath, toBytes(raw));
  } catch (error) {
    return { ok: false, message: describeLutError(error) };
  }
}

/** Import a `File` the user dropped onto the panel. */
export async function importLutFile(file: File): Promise<LutImportResult> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return await installFrom(lutNameFrom(file.name), file.name, bytes);
  } catch (error) {
    return { ok: false, message: describeLutError(error) };
  }
}

/**
 * Parse, then install.
 *
 * The parse is not a validation step that could be skipped — its result is
 * returned, so the caller can show the grade immediately without waiting for
 * the registry to reload and the file to be read a second time.
 */
async function installFrom(
  name: string,
  filename: string,
  bytes: Uint8Array,
): Promise<LutImportResult> {
  let lut: LutData;
  try {
    lut = isImageLutFilename(filename)
      ? await parseImageBytes(bytes)
      : parseLutText(new TextDecoder("utf-8").decode(bytes), filename);
  } catch (error) {
    return { ok: false, message: describeLutError(error) };
  }

  const preset = bridge<PresetBridge>("preset");
  if (preset?.installLut == null) {
    return { ok: false, message: "no preset bridge is available here" };
  }

  try {
    const { id } = await preset.installLut(name, extensionOf(filename), bytes);
    // Re-read the folders so the new preset is in the registry. `loadPresets`
    // notifies its subscribers, which is what repaints the panel.
    await loadPresets();
    return { ok: true, id, name, lut };
  } catch (error) {
    return { ok: false, message: describeLutError(error) };
  }
}

/** Decode PNG bytes through the browser's own decoder. */
async function parseImageBytes(bytes: Uint8Array): Promise<LutData> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("that image could not be decoded"));
      element.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx == null) {
      throw new Error("no 2d context to decode the image LUT with");
    }
    ctx.drawImage(image, 0, 0);
    return parseImageLut(ctx.getImageData(0, 0, canvas.width, canvas.height));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Whatever `filesystem:readFile` handed back, as bytes. */
function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  if (typeof raw === "string") {
    return new TextEncoder().encode(raw);
  }
  throw new Error("that file could not be read");
}
