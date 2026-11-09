/**
 * Saving and opening a `.ngt` in a browser, where there is no main process to
 * own a dialog or a path.
 *
 * **Chrome and Edge** have the File System Access API: Save asks once where to
 * put the project and keeps the `FileSystemFileHandle`, so the next ⌘S writes
 * the same file in place, and Open keeps the handle it opened. Each media file
 * a saved project names has its handle filed in IndexedDB under the file's
 * identity (`webStore.ts`), so reopening the project, even in a later visit,
 * reconnects its media after one permission prompt.
 *
 * **Safari and Firefox** do not: Save downloads the archive under a name the
 * user gives once (`webFileDialog.ts`), Open reads a picked file, and a
 * reopened project's media is matched against files the user picks again, by
 * name and size (`webMediaLinks.ts#matchPicked`).
 *
 * `#projectFile` holds the file's *name* here, never a path: it is what the
 * title bar shows, what the Auto Save key is made from, and what Save As
 * clears to make Save ask again.
 */

import { importedMediaStore } from "../../asset/webMedia/importedMedia";
import { registeredMedia } from "../../asset/webMedia/mediaRegistry";
import { idbGet, idbPut, MEDIA_HANDLES } from "./webStore";
import {
  WEB_MEDIA_ENTRY,
  blobPathsIn,
  identitiesFor,
  identityKey,
  matchPicked,
  parseWebMediaEntry,
  webMediaEntry,
  type MediaIdentity,
} from "./webMediaLinks";
import type { NameRequest, RelinkItem, WebFileDialog } from "./webFileDialog";

/**
 * The dialog, loaded when first asked for. It is a Lit element that registers
 * itself on import, and this module is reached from code the node suites
 * import (`autosaveBridge.ts`), where there is no `customElements` to
 * register with.
 */
async function dialog(): Promise<WebFileDialog> {
  const { webFileDialog } = await import("./webFileDialog");
  return webFileDialog();
}

/** What `showOpenFilePicker`/`showSaveFilePicker` offer for a project. */
const NGT_TYPES = [{ description: "CartCut Project", accept: { "application/zip": [".ngt"] } }];

type FileHandle = {
  name: string;
  kind?: string;
  getFile(): Promise<File>;
  createWritable?(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  queryPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};

export type SaveTarget = { name: string; handle: FileHandle | null };

/** The file this tab last saved to or opened, for ⌘S to write again. */
let current: SaveTarget | null = null;

export function rememberTarget(target: SaveTarget | null): void {
  current = target;
}

/** The remembered target, if it is still the project `#projectFile` names. */
export function targetNamed(name: string): SaveTarget | null {
  return current != null && current.name === name ? current : null;
}

function pickerApi(name: "showSaveFilePicker" | "showOpenFilePicker"): ((options: unknown) => Promise<any>) | null {
  const fn = (window as unknown as Record<string, unknown>)[name];
  return typeof fn === "function" ? (fn as (options: unknown) => Promise<any>).bind(window) : null;
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

/** A name ending in `.ngt`. */
export function ngtName(name: string): string {
  const trimmed = name.trim() === "" ? "Untitled" : name.trim();
  return /\.ngt$/i.test(trimmed) ? trimmed : `${trimmed}.ngt`;
}

/**
 * Ask where to save a file, or `null` when cancelled: the save picker where
 * there is one, else a name for a download.
 *
 * **The first thing awaited after the click or the keystroke**, because the
 * save picker needs the user activation they carry and anything awaited first
 * can outlast it. Building what is written comes after.
 */
export async function chooseFileTarget(
  suggested: string,
  kind: { types: unknown[]; request?: NameRequest },
): Promise<SaveTarget | null> {
  const picker = pickerApi("showSaveFilePicker");
  if (picker != null) {
    try {
      const handle = (await picker({ suggestedName: suggested, types: kind.types })) as FileHandle;
      return { name: handle.name, handle };
    } catch (error) {
      if (isAbort(error)) {
        return null;
      }
      // A picker that exists and fails (a sandboxed frame) leaves the download.
      console.warn("[project] the save picker failed; saving as a download", error);
    }
  }
  const name = await (await dialog()).askName(suggested, kind.request);
  return name == null ? null : { name, handle: null };
}

/** Where a project goes. See `chooseFileTarget`. */
export function chooseSaveTarget(suggested: string): Promise<SaveTarget | null> {
  return chooseFileTarget(ngtName(suggested), { types: NGT_TYPES });
}

/** Hand a blob to the browser as a download under `name`. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Long enough for any browser to have started reading it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export type WriteOutcome =
  | { ok: true; confirmed: boolean }
  | { ok: false; message: string };

/**
 * Write the archive. `confirmed` is true only when the bytes are known to be
 * in the file (a handle's writer closed); a download is handed to the browser
 * and nothing reports whether it was kept.
 */
export async function writeTarget(target: SaveTarget, blob: Blob): Promise<WriteOutcome> {
  if (target.handle?.createWritable != null) {
    try {
      const writable = await target.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, confirmed: true };
    } catch (error) {
      return { ok: false, message: `The project could not be saved: ${String((error as Error)?.message ?? error)}` };
    }
  }
  downloadBlob(blob, target.name);
  return { ok: true, confirmed: false };
}

/**
 * Let the user pick files: the File System Access picker where there is one,
 * an `<input type=file>` where there is not. `[]` when cancelled.
 */
export async function pickFiles(options: {
  accept: string;
  types?: unknown[];
  multiple: boolean;
}): Promise<Array<{ file: File; handle: FileHandle | null }>> {
  const picker = pickerApi("showOpenFilePicker");
  if (picker != null) {
    try {
      const handles = (await picker({
        multiple: options.multiple,
        ...(options.types != null ? { types: options.types } : {}),
      })) as FileHandle[];
      return await Promise.all(handles.map(async (handle) => ({ file: await handle.getFile(), handle })));
    } catch (error) {
      if (!isAbort(error)) {
        console.warn("[project] the open picker failed", error);
      }
      return [];
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.multiple = options.multiple;
    input.style.display = "none";
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) {
        return;
      }
      settled = true;
      input.remove();
      resolve(files.map((file) => ({ file, handle: null })));
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
    // Chrome 113, Safari 16.4 and Firefox 91 say when the picker was dismissed.
    input.addEventListener("cancel", () => finish([]), { once: true });
    // Attached before the click: Safari ignores `click()` on a detached input.
    document.body.appendChild(input);
    input.click();
  });
}

/** Pick one `.ngt`. */
export async function pickProjectFile(): Promise<{ file: File; handle: FileHandle | null } | null> {
  const picked = await pickFiles({ accept: ".ngt,application/zip", types: NGT_TYPES, multiple: false });
  return picked[0] ?? null;
}

function identityOfRegistered(path: string): MediaIdentity | null {
  const media = registeredMedia(path);
  if (media == null) {
    return null;
  }
  const file = media.file as File;
  return {
    name: media.name,
    size: Number.isFinite(file.size) ? file.size : null,
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
    type: file.type ?? "",
  };
}

/**
 * The archive entry recording what each `blob:` path in `documents` is, and
 * the handles of those files filed for the next visit. `{}` when the project
 * names no browser media, so its archive is what it would be anywhere else.
 */
export function webMediaExtraEntries(documents: unknown): Record<string, string> {
  const paths = blobPathsIn(documents);
  for (const path of paths) {
    const media = registeredMedia(path);
    const identity = identityOfRegistered(path);
    if (media?.handle != null && identity != null) {
      void idbPut(MEDIA_HANDLES, identityKey(identity), media.handle);
    }
  }
  const text = webMediaEntry(paths, identityOfRegistered);
  return text == null ? {} : { [WEB_MEDIA_ENTRY]: text };
}

/**
 * Point every `blob:` path in a reopened project at a live file. Answers the
 * map from the archive's dead paths to this session's live ones, and how many
 * files stayed missing.
 *
 * In order: a path this tab can still read is left alone; a file whose handle
 * was filed is reopened if permission stands; anything else is shown in the
 * reconnect dialog, where the user can grant access to the remembered ones and
 * locate the rest.
 */
export async function reconnectMedia(
  documents: unknown,
  entryText: string | null | undefined,
): Promise<{ map: Map<string, string>; missing: number }> {
  const dead = [...blobPathsIn(documents)].filter((path) => registeredMedia(path) == null);
  const map = new Map<string, string>();
  if (dead.length === 0) {
    return { map, missing: 0 };
  }

  const identities = identitiesFor(dead, parseWebMediaEntry(entryText));
  const found = new Map<string, { file: File; handle: FileHandle | null }>();
  const awaitingPermission = new Map<string, FileHandle>();

  for (const [path, identity] of identities) {
    const handle = await idbGet<FileHandle>(MEDIA_HANDLES, identityKey(identity));
    if (handle == null || typeof handle.getFile !== "function") {
      continue;
    }
    try {
      const permission = (await handle.queryPermission?.({ mode: "read" })) ?? "granted";
      if (permission === "granted") {
        found.set(path, { file: await handle.getFile(), handle });
      } else if (permission === "prompt") {
        awaitingPermission.set(path, handle);
      }
    } catch {
      // The file was moved or deleted since; it is missing.
    }
  }

  const unresolved = () => [...identities.keys()].filter((path) => !found.has(path));
  if (unresolved().length > 0) {
    const items = (): RelinkItem[] =>
      [...identities].map(([path, identity]) => ({
        name: identity.name,
        state: found.has(path) ? "found" : awaitingPermission.has(path) ? "permission" : "missing",
      }));
    await (await dialog()).relink({
      items,
      allow: async () => {
        for (const [path, handle] of [...awaitingPermission]) {
          try {
            const permission = await handle.requestPermission?.({ mode: "read" });
            if (permission === "granted") {
              found.set(path, { file: await handle.getFile(), handle });
              awaitingPermission.delete(path);
            }
          } catch {
            awaitingPermission.delete(path);
          }
        }
      },
      locate: async () => {
        const waiting = new Map([...identities].filter(([path]) => !found.has(path)));
        const picked = await pickFiles({ accept: "video/*,image/*,audio/*", multiple: true });
        const matches = matchPicked(
          waiting,
          picked.map(({ file }) => ({ name: file.name, size: file.size, lastModified: file.lastModified })),
        );
        for (const [path, index] of matches) {
          found.set(path, picked[index]);
          awaitingPermission.delete(path);
        }
      },
    });
  }

  // Into the asset panel's list as well as the registry, as a fresh import
  // would be: the same file picked twice keeps one path (`importedMedia.ts`).
  for (const [path, { file, handle }] of found) {
    const [live] = importedMediaStore.getState().add([{ file, ...(handle != null ? { handle } : {}) }]);
    if (live != null) {
      map.set(path, live);
    }
    if (handle != null) {
      const identity = identities.get(path);
      if (identity != null) {
        void idbPut(MEDIA_HANDLES, identityKey(identity), handle);
      }
    }
  }
  return { map, missing: unresolved().length };
}
