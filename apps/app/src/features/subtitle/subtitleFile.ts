/**
 * The file half of subtitle import and export: dialogs, bytes, and nothing else.
 *
 * Split from the pure layer so `parse.ts` and `serialize.ts` can stay reachable
 * from a node suite with no bridge at all. Everything here touches
 * `window.electronAPI` and none of it is tested; everything it decides is in
 * one of the modules beside it.
 *
 * The bridge is reached through narrow structural types read off `globalThis`,
 * the shape `lut/lutImport.ts` and `template/templateExport.ts` both use. That
 * typechecks without preload's own types and degrades in the web build, where
 * the stubs in `functions/ipcWrapper.ts` answer `"none"` for a cancelled
 * dialog.
 */

import { bytesToBase64 } from "../../utils/base64";
import type { SubtitleFlavour } from "./cues";
import { decodeSubtitleBytes, type SubtitleEncoding } from "./encoding";
import { parseSubtitles, type SubtitleParse } from "./parse";

export const SUBTITLE_EXTENSIONS = ["srt", "vtt"] as const;

type DialogBridge = {
  openFiles?: (extensions: string[]) => Promise<unknown>;
  saveSubtitles?: () => Promise<unknown>;
};

type FilesystemBridge = {
  readFile?: (path: string) => Promise<unknown>;
  /** See `ipcFilesystem.writeFileEnsured`: awaited, and it reports failure. */
  writeFileEnsured?: (
    path: string,
    base64: string,
  ) => Promise<{ status: boolean; error?: string }>;
};

function bridge<T>(key: "dialog" | "filesystem"): T | null {
  const api = (globalThis as { electronAPI?: { req?: Record<string, unknown> } })
    .electronAPI;
  return (api?.req?.[key] as T | undefined) ?? null;
}

export type SubtitleReadResult =
  | { ok: true; path: string; parse: SubtitleParse; encoding: SubtitleEncoding }
  | { ok: false; path: string; message: string };

/**
 * Which format a path names.
 *
 * Only used for writing, where the extension the user chose in the save dialog
 * is the whole answer. Reading asks `sniffFlavour`, which trusts the content
 * first: a `.srt` holding a WebVTT file is not unusual.
 */
export function flavourForPath(path: string): SubtitleFlavour {
  return /\.vtt$/i.test(path) ? "vtt" : "srt";
}

/** The file's own name, for a dialog title. */
export function subtitleNameFrom(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Empty means cancelled, and a caller must not report it.
 *
 * The same rule `pickAndImportLut` states: a toast after a cancelled dialog
 * tells the user off for changing their mind.
 */
export async function pickSubtitleFiles(): Promise<string[]> {
  const dialog = bridge<DialogBridge>("dialog");
  if (dialog?.openFiles == null) {
    return [];
  }
  const picked = await dialog.openFiles([...SUBTITLE_EXTENSIONS]);
  return Array.isArray(picked) ? picked.filter(isRealPath) : [];
}

/** Null means cancelled. */
export async function pickSubtitleDestination(): Promise<string | null> {
  const dialog = bridge<DialogBridge>("dialog");
  if (dialog?.saveSubtitles == null) {
    return null;
  }
  const picked = await dialog.saveSubtitles();
  return typeof picked === "string" && isRealPath(picked) ? picked : null;
}

/**
 * Read and parse, in that order and both before anything is placed.
 *
 * `lutImport.ts` states the rule: refuse a malformed file before installing
 * anything, never halfway through. Here that means every file in a batch is
 * parsed before the first caption reaches the document.
 */
export async function readSubtitleFile(
  path: string,
): Promise<SubtitleReadResult> {
  const filesystem = bridge<FilesystemBridge>("filesystem");
  if (filesystem?.readFile == null) {
    return { ok: false, path, message: "No filesystem bridge to read with." };
  }

  let raw: unknown;
  try {
    raw = await filesystem.readFile(path);
  } catch (error) {
    return { ok: false, path, message: messageOf(error) };
  }

  const bytes = toBytes(raw);
  if (bytes == null) {
    return { ok: false, path, message: "That file could not be read." };
  }

  const decoded = decodeSubtitleBytes(bytes);
  return {
    ok: true,
    path,
    parse: parseSubtitles(decoded.text, path),
    encoding: decoded.encoding,
  };
}

export async function writeSubtitleFile(
  path: string,
  text: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const filesystem = bridge<FilesystemBridge>("filesystem");
  // `writeFileEnsured`, never `writeFile`: the older one calls the callback
  // form of `fs.writeFile` and returns before it runs, so a failure is
  // indistinguishable from success.
  if (filesystem?.writeFileEnsured == null) {
    return { ok: false, message: "No filesystem bridge to write with." };
  }

  try {
    const written = await filesystem.writeFileEnsured(
      path,
      bytesToBase64(new TextEncoder().encode(text)),
    );
    if (written?.status !== true) {
      return { ok: false, message: written?.error ?? "That file could not be written." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

/**
 * `readFile` hands back a Node `Buffer`, which crosses IPC as a `Uint8Array`.
 * The string branch is the web shim, which has no filesystem at all.
 */
function toBytes(raw: unknown): Uint8Array | null {
  if (typeof raw === "string") {
    return new TextEncoder().encode(raw);
  }
  if (raw instanceof Uint8Array) {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return new Uint8Array(raw);
  }
  return null;
}

/** The web shim answers `"none"` for a dialog the user dismissed. */
function isRealPath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value !== "none";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
