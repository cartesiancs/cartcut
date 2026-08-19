/**
 * Video thumbnails, keyed by the encoded file URL.
 *
 * These are blob URLs — not serializable, so they do not belong in a store.
 * They used to live on the `<asset-list>` DOM element as a plain object that
 * child elements wrote into directly, which is why every `asset-file` had to
 * reach back out through `document.querySelector`.
 */
const thumbnails = new Map<string, string>();

export const thumbnailCache = {
  get(url: string): string | undefined {
    return thumbnails.get(url);
  },

  set(url: string, blobUrl: string): void {
    thumbnails.set(url, blobUrl);
  },

  has(url: string): boolean {
    return thumbnails.has(url);
  },
};
