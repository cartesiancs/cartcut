/**
 * Reading a catalog the server sent. Plain TypeScript, no Electron.
 *
 * Everything here arrives from the network and is about to become folder
 * names and file paths under `userData`, so nothing is trusted and nothing is
 * sanitised: an item with one unusable id, path, size or digest is dropped
 * whole, the rule `features/template/archive.ts` keeps for a hostile archive.
 * The server applies the same rules before it lists anything (`server/src/
 * catalog.rs`); this side holds them again because the server is not the only
 * thing that can answer a request.
 *
 * The extension lists are the preset scanner's own, imported rather than
 * copied, so a file this accepts is one the scanner will read.
 */

import {
  ASSET_EXTENSIONS,
  MAX_SHADER_BYTES,
  SHADER_EXTENSIONS,
  TEXT_SOURCE_EXTENSIONS,
} from "../presetScan";
import { isPresetKind, type CloudKind } from "./cloudPaths";

export type CloudFile = { path: string; bytes: number; sha256: string };

export type CloudMedia = {
  type: "video" | "image" | "audio";
  durationMs: number | null;
  width: number | null;
  height: number | null;
};

export type CloudItem = {
  id: string;
  kind: CloudKind;
  name: string;
  category: string | null;
  author: string | null;
  version: string | null;
  /** A preset's manifest schema, or a template's document schema. */
  schema: number | null;
  /** One of `files`, or `null`. */
  thumbnail: string | null;
  files: CloudFile[];
  bytes: number;
  /** Assets only: the media file among `files`. */
  file: string | null;
  media: CloudMedia | null;
};

const VIDEO = [".mp4", ".webm", ".mov"];
const IMAGE = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const AUDIO = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"];
const FONT = [".woff2", ".woff", ".ttf", ".otf"];
const LUT_FILE = [".cube", ".3dl"];
const THUMBNAILS = ["thumbnail.webp", "thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg"];

/** `presetScan.ts#PRESET_SUBDIR_DEPTH` plus the file itself. */
const PRESET_SEGMENTS = 2;
const TEMPLATE_SEGMENTS = 5;

const MAX_ITEMS = 5000;
const MAX_FILES = 256;
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 512;
const MAX_NAME_LENGTH = 200;
/** Per item. A preset is kilobytes; media is the large case. */
const MAX_PRESET_BYTES = 64 * 1024 * 1024;
const MAX_ITEM_BYTES = 4 * 1024 * 1024 * 1024;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNPORTABLE = /[<>:"|?*\\\u0000-\u001f\u007f]/;

/** `CON`, `NUL`, `COM1` and the rest, with or without an extension. */
function isDeviceName(name: string): boolean {
  const stem = name.split(".")[0].toUpperCase();
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

/**
 * An id that is safe as one folder name on every platform the app runs on.
 *
 * The app's preset id pattern, plus no trailing dot (Windows strips it, so
 * `a.` and `a` would be one folder) and no device name.
 */
export function isUsableCloudId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ID_LENGTH &&
    ID_PATTERN.test(value) &&
    !value.endsWith(".") &&
    !isDeviceName(value)
  );
}

/** One path segment the app can create on macOS, Windows and Linux. */
function isPortableSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".") &&
    !segment.endsWith(".") &&
    !segment.endsWith(" ") &&
    segment.length <= 255 &&
    !UNPORTABLE.test(segment) &&
    !isDeviceName(segment)
  );
}

/**
 * A relative POSIX path with no climb, no absolute start, no drive letter and
 * no backslash: what `archive.ts#isSafeEntryName` accepts, and stricter about
 * names Windows cannot hold.
 */
export function isSafeCloudPath(value: unknown, maxSegments: number): value is string {
  if (typeof value !== "string" || value === "" || value.length > MAX_PATH_LENGTH) {
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.length <= maxSegments && segments.every(isPortableSegment);
}

function extensionOf(file: string): string {
  const last = file.slice(file.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot <= 0 ? "" : last.slice(dot).toLowerCase();
}

function text(value: unknown, max = MAX_NAME_LENGTH): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Which files an item of this kind may carry. */
function allowsFile(kind: CloudKind, file: string, media: string | null): boolean {
  const extension = extensionOf(file);
  if (isPresetKind(kind)) {
    return (
      file === "manifest.json" ||
      SHADER_EXTENSIONS.includes(extension) ||
      TEXT_SOURCE_EXTENSIONS.includes(extension) ||
      ASSET_EXTENSIONS.includes(extension)
    );
  }
  if (kind === "template") {
    return (
      file === "template.ngt" ||
      file === "template.json" ||
      [...IMAGE, ...VIDEO, ...AUDIO, ...FONT, ...LUT_FILE].includes(extension)
    );
  }
  return (
    file === "asset.json" ||
    file === media ||
    (THUMBNAILS.includes(file) && IMAGE.includes(extension))
  );
}

function readMedia(raw: unknown): CloudMedia | null {
  if (raw == null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.type !== "video" && record.type !== "image" && record.type !== "audio") {
    return null;
  }
  return {
    type: record.type,
    durationMs: count(record.durationMs),
    width: count(record.width),
    height: count(record.height),
  };
}

/** One item, or the reason it was dropped. */
function readItem(kind: CloudKind, raw: unknown): CloudItem | string {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return "not an object";
  }
  const record = raw as Record<string, unknown>;

  if (!isUsableCloudId(record.id)) {
    return "unusable id";
  }
  const id = record.id;
  if (record.kind !== kind) {
    return `${id}: listed under ${kind} but says ${String(record.kind)}`;
  }
  const name = text(record.name);
  if (name == null) {
    return `${id}: no name`;
  }

  const media = kind === "asset" ? readMedia(record.media) : null;
  const mediaFile = kind === "asset" ? record.file : null;
  if (kind === "asset") {
    const allowed =
      media?.type === "video" ? VIDEO : media?.type === "image" ? IMAGE : AUDIO;
    if (
      media == null ||
      !isSafeCloudPath(mediaFile, 1) ||
      !allowed.includes(extensionOf(mediaFile))
    ) {
      return `${id}: no usable media file`;
    }
  }

  if (!Array.isArray(record.files) || record.files.length === 0 || record.files.length > MAX_FILES) {
    return `${id}: no usable file list`;
  }
  const maxSegments =
    kind === "template" ? TEMPLATE_SEGMENTS : kind === "asset" ? 1 : PRESET_SEGMENTS;
  const files: CloudFile[] = [];
  // Case-insensitively, because `Shader.frag` and `shader.frag` are one file
  // on the two filesystems most users have.
  const seen = new Set<string>();
  let total = 0;
  for (const entry of record.files) {
    const file = entry as Record<string, unknown> | null;
    const filePath = file?.path;
    const bytes = count(file?.bytes);
    const sha256 = file?.sha256;
    if (
      !isSafeCloudPath(filePath, maxSegments) ||
      bytes == null ||
      typeof sha256 !== "string" ||
      !SHA256_PATTERN.test(sha256)
    ) {
      return `${id}: an unusable file entry`;
    }
    if (!allowsFile(kind, filePath, typeof mediaFile === "string" ? mediaFile : null)) {
      return `${id}: ${filePath} is not a file the app reads`;
    }
    const isText =
      isPresetKind(kind) &&
      [...SHADER_EXTENSIONS, ...TEXT_SOURCE_EXTENSIONS].includes(extensionOf(filePath));
    if (isText && bytes > MAX_SHADER_BYTES) {
      return `${id}: ${filePath} is larger than the app reads`;
    }
    const key = filePath.toLowerCase();
    if (seen.has(key)) {
      return `${id}: ${filePath} is listed twice`;
    }
    seen.add(key);
    total += bytes;
    files.push({ path: filePath, bytes, sha256 });
  }

  const cap = isPresetKind(kind) ? MAX_PRESET_BYTES : MAX_ITEM_BYTES;
  if (total > cap) {
    return `${id}: ${total} bytes is more than one item may be`;
  }
  const required =
    kind === "template" ? "template.ngt" : kind === "asset" ? mediaFile : "manifest.json";
  if (!files.some((file) => file.path === required)) {
    return `${id}: ${String(required)} is missing`;
  }

  const thumbnail = typeof record.thumbnail === "string" ? record.thumbnail : null;
  return {
    id,
    kind,
    name,
    category: text(record.category, 64),
    author: text(record.author),
    version: text(record.version, 32),
    schema: count(record.schema),
    // Only a thumbnail that is itself downloaded, so an installed item can
    // show it with the network gone.
    thumbnail: thumbnail != null && files.some((file) => file.path === thumbnail) ? thumbnail : null,
    files,
    bytes: total,
    file: typeof mediaFile === "string" ? mediaFile : null,
    media,
  };
}

/**
 * The usable items of one catalog response, and why the others were dropped.
 *
 * Never throws. A response that is not a catalog at all reads as an empty one,
 * which shows the user exactly what an unreachable server would: their local
 * content and nothing else.
 */
export function parseCatalog(
  kind: CloudKind,
  json: unknown,
): { items: CloudItem[]; rejected: string[] } {
  const record = json as Record<string, unknown> | null;
  if (record == null || typeof record !== "object" || !Array.isArray(record.items)) {
    return { items: [], rejected: ["the response is not a catalog"] };
  }

  const items: CloudItem[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of record.items.slice(0, MAX_ITEMS)) {
    const item = readItem(kind, raw);
    if (typeof item === "string") {
      rejected.push(item);
      continue;
    }
    // Two ids differing only in case are one folder on macOS and Windows.
    const key = item.id.toLowerCase();
    if (seen.has(key)) {
      rejected.push(`${item.id}: listed twice`);
      continue;
    }
    seen.add(key);
    items.push(item);
  }
  return { items, rejected };
}
