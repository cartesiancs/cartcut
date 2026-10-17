/**
 * Where the browser export reads a clip's bytes from.
 *
 * The one place a `localpath` becomes something Mediabunny can demux:
 *
 *   - a picked or dropped file (`blob:`): the `File` itself from
 *     `mediaRegistry`, read by range straight from disk;
 *   - anything the page can fetch (`https:`, the demo's `/sample/...`, the
 *     self-hosted `/api/file?path=`): by URL, with range requests;
 *   - a `file://` path, which a project made in the desktop app holds: not
 *     readable from a page at all, so it is reported missing before the export
 *     begins, the way the desktop export reports a file that is not on disk.
 */

import { BlobSource, UrlSource, type Source } from "mediabunny";
import { mediaUrlFor, type LocationEnv } from "../../../functions/mediaUrl";
import { registeredMedia } from "./mediaRegistry";

export type SourceKind = "file" | "url" | "missing";

/** Pure: which route `localpath` takes, given whether its file was registered. */
export function sourceKindOf(localpath: string, registered: boolean): SourceKind {
  if (localpath.startsWith("blob:")) {
    // An object URL this session did not make (or one from before a reload)
    // has nothing behind it.
    return registered ? "file" : "missing";
  }
  if (/^file:/i.test(localpath) || localpath === "") {
    return "missing";
  }
  return "url";
}

/** The Mediabunny source for `localpath`, or `null` when nothing can be read. */
export function sourceFor(localpath: string, env: LocationEnv): Source | null {
  const media = registeredMedia(localpath);
  switch (sourceKindOf(localpath, media != null)) {
    case "file":
      return new BlobSource(media!.file);
    case "url":
      return new UrlSource(mediaUrlFor(localpath, env));
    default:
      return null;
  }
}

/** A clip's file name, for a message that has to say which one. */
export function displayNameOf(localpath: string): string {
  const media = registeredMedia(localpath);
  if (media != null) {
    return media.name;
  }
  const fragment = localpath.includes("#") ? localpath.slice(localpath.lastIndexOf("#") + 1) : "";
  if (fragment !== "") {
    return fragment;
  }
  const withoutQuery = localpath.split("?")[0];
  const name = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name) || localpath;
  } catch {
    return name || localpath;
  }
}
