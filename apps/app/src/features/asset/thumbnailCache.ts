/**
 * Video thumbnails, keyed by the encoded file URL.
 *
 * These are blob URLs — not serializable, so they do not belong in a store.
 * They used to live on the `<asset-list>` DOM element as a plain object that
 * child elements wrote into directly, which is why every `asset-file` had to
 * reach back out through `document.querySelector`.
 *
 * The source's pixel dimensions ride along with the URL because
 * `captureVideoThumbnail` already has them — it reads `videoWidth`/`videoHeight`
 * to size its canvas — and throwing them away costs the hover preview a visible
 * reflow: it must open the instant the dwell completes, which is before
 * `loadedmetadata`, so without a known aspect it opens as a 16:9 guess and
 * jumps when the real numbers arrive.
 */

export type Thumbnail = {
  /** A blob URL for a single decoded frame. */
  url: string;
  /** The source's own pixel dimensions, not the thumbnail's. */
  w: number;
  h: number;
};

const thumbnails = new Map<string, Thumbnail>();

export const thumbnailCache = {
  get(url: string): Thumbnail | undefined {
    return thumbnails.get(url);
  },

  set(url: string, thumbnail: Thumbnail): void {
    thumbnails.set(url, thumbnail);
  },

  has(url: string): boolean {
    return thumbnails.has(url);
  },
};
