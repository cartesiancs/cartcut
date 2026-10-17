/**
 * The files a browser build was handed, by the URL the timeline knows them as.
 *
 * In a browser a picked or dropped file reaches the editor as a `File`, and the
 * timeline stores the object URL made from it (`blob:...#name.ext`, see
 * `pickedMediaPath`). The `<video>` and `<img>` handles load that URL and need
 * nothing more. An export does: it demuxes the file with Mediabunny, and the
 * honest source for that is the `File` itself, which reads byte ranges straight
 * from disk. Fetching the object URL instead would copy the whole file into
 * memory first.
 *
 * Keyed by the object URL without its fragment, because the fragment is only
 * the file's name riding along for the extension test.
 *
 * `handle` is kept when the File System Access API supplied one, so a later
 * change can persist it and ask for permission again after a reload. Nothing
 * reads it yet.
 *
 * DOM-free: `URL.createObjectURL` exists in Node too, so the suite runs under
 * `environment: "node"`.
 */

export type RegisteredMedia = {
  readonly file: Blob;
  readonly name: string;
  readonly handle?: unknown;
};

const byUrl = new Map<string, RegisteredMedia>();

/** What everything downstream decides a file's kind from, `mediaElement.ts#mediaKindOf`. */
const EXTENSION_FOR_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
};

/**
 * The path a picked file is imported under.
 *
 * Everything downstream decides what a file is from its extension
 * (`mediaElement.ts#mediaKindOf`), and an object URL has none. So the file's
 * name rides along as the URL's fragment, which loading ignores and the
 * extension test reads. The name is reduced to one path segment with no `#` or
 * `?`, so it can neither end the fragment nor be read as a folder, and a name
 * without an extension (some phone pickers hand over `image` or `video`) is
 * given the one its MIME type implies.
 */
export function pickedMediaPath(objectUrl: string, name: string, type: string): string {
  let safe = name.replace(/[#?/\\]/g, "_").trim();
  if (safe === "") {
    safe = "media";
  }
  if (!/\.[a-z0-9]{2,5}$/i.test(safe)) {
    const extension = EXTENSION_FOR_TYPE[type.toLowerCase()];
    if (extension != null) {
      safe = `${safe}.${extension}`;
    }
  }
  return `${objectUrl}#${safe}`;
}

/** The registry key for a path: the object URL without its name fragment. */
export function objectUrlOf(localpath: string): string | null {
  if (!localpath.startsWith("blob:")) {
    return null;
  }
  const hash = localpath.indexOf("#");
  return hash === -1 ? localpath : localpath.slice(0, hash);
}

/**
 * Make an object URL for `file`, remember the file under it, and answer the
 * path to import it as.
 */
export function registerPickedFile(
  file: File,
  handle?: unknown,
  createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): string {
  const url = createUrl(file);
  byUrl.set(url, { file, name: file.name, ...(handle != null ? { handle } : {}) });
  return pickedMediaPath(url, file.name, file.type);
}

/** The file behind a `blob:` path this session was handed, or `null`. */
export function registeredMedia(localpath: string): RegisteredMedia | null {
  const key = objectUrlOf(localpath);
  return key == null ? null : (byUrl.get(key) ?? null);
}

/** For the suites: forget everything. */
export function clearMediaRegistry(): void {
  byUrl.clear();
}
