/**
 * The cloud API's shapes, as the renderer receives them.
 *
 * Hand-copied from `electron/lib/cloud/cloudCatalog.ts#CloudItem` and
 * `cloudSession.ts#PublicCloudItem`. `electron/` may not import from
 * `apps/app/src` (it relocates the main build), so the two sides are kept in
 * step by hand, as `PresetOrigin` is.
 */

export type CloudKind = "effect" | "transition" | "graphic" | "lut" | "template" | "asset";

/** The kinds the FX tab shows. All four are presets to the app. */
export type FxCloudKind = "effect" | "transition" | "graphic" | "lut";

/**
 * What main answered about one catalog. `disabled`, `offline` and
 * `unreachable` all show the same thing: local content only.
 */
export type CloudStatus = "ok" | "disabled" | "offline" | "unreachable";

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
  thumbnail: string | null;
  bytes: number;
  /** Assets only: the media file's name. */
  file: string | null;
  media: CloudMedia | null;
  /** Where to fetch the thumbnail while online, or `null`. */
  thumbnailUrl: string | null;
  installed: boolean;
  /** Installed assets only: the media file on disk, ready for `importPathsAt`. */
  localPath: string | null;
  /** Installed items only: the thumbnail on disk, POSIX-separated. */
  localThumbnail: string | null;
};

export type CloudDownloadOutcome =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: "disabled" | "offline" | "unreachable" | "missing" | "cancelled" | "failed";
      message?: string;
    };

export function cloudKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}
