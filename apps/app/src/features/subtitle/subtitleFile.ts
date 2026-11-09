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
import { isBrowserBuild } from "../../functions/getLocationEnv";
import { registerPickedFile, registeredMedia } from "../asset/webMedia/mediaRegistry";
import type { SaveTarget } from "../project/web/webProjectFile";

/** What the browser's save picker offers for subtitles. */
const SUBTITLE_TYPES = [
  { description: "SubRip Subtitles", accept: { "application/x-subrip": [".srt"] } },
  { description: "WebVTT Subtitles", accept: { "text/vtt": [".vtt"] } },
];

/**
 * Where each browser export is going, by the name handed back as its "path".
 * A browser has no path: the name is what decides the format
 * (`flavourForPath`) and what the toast reports, and this is where the handle
 * or the download it stands for is kept until the write.
 */
const browserTargets = new Map<string, SaveTarget>();

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
  if (isBrowserBuild()) {
    // Read from the `File` itself (`readSubtitleFile` below), so registered
    // like a picked media file but not listed in the asset panel.
    const { pickFiles } = await import("../project/web/webProjectFile");
    const picked = await pickFiles({
      accept: ".srt,.vtt",
      types: [{ description: "Subtitles", accept: { "text/plain": [".srt", ".vtt"] } }],
      multiple: true,
    });
    return picked.map(({ file }) => registerPickedFile(file));
  }
  const dialog = bridge<DialogBridge>("dialog");
  if (dialog?.openFiles == null) {
    return [];
  }
  const picked = await dialog.openFiles([...SUBTITLE_EXTENSIONS]);
  return Array.isArray(picked) ? picked.filter(isRealPath) : [];
}

/** Null means cancelled. */
export async function pickSubtitleDestination(): Promise<string | null> {
  if (isBrowserBuild()) {
    const { chooseFileTarget } = await import("../project/web/webProjectFile");
    const target = await chooseFileTarget("subtitles.srt", {
      types: SUBTITLE_TYPES,
      request: {
        title: "Export Subtitles",
        note: "This browser saves the subtitles as a download. End the name in .vtt for WebVTT.",
        extensions: [".srt", ".vtt"],
      },
    });
    if (target == null) {
      return null;
    }
    browserTargets.set(target.name, target);
    return target.name;
  }
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
  // A browser's picked or dropped file: read the `File` the registry holds.
  // The filesystem shim would answer the string "none" for it, which decoded
  // as a subtitle file holding nothing.
  const picked = registeredMedia(path);
  if (picked != null) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await picked.file.arrayBuffer());
    } catch (error) {
      return { ok: false, path, message: messageOf(error) };
    }
    const decoded = decodeSubtitleBytes(bytes);
    return {
      ok: true,
      path,
      parse: parseSubtitles(decoded.text, path),
      encoding: decoded.encoding,
    };
  }
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
  const target = browserTargets.get(path);
  if (target != null) {
    browserTargets.delete(path);
    const { writeTarget } = await import("../project/web/webProjectFile");
    const written = await writeTarget(
      target,
      new Blob([text], { type: flavourForPath(path) === "vtt" ? "text/vtt" : "application/x-subrip" }),
    );
    return written.ok ? { ok: true } : { ok: false, message: written.message };
  }
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
