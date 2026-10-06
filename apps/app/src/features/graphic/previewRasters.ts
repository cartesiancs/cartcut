/**
 * The preview's HTML rasters: the latest one per clip, and the device scale
 * each clip was last drawn at.
 *
 * The preview draws whatever raster is newest, a frame or two behind while a
 * scrub outruns the host's paint, the way `renderVideoWithoutWait` draws
 * whatever frame its `<video>` holds. The key says which frame a raster is, so
 * the prepare step can skip a clip whose raster is already current, and a
 * static graphic is rasterised once and then left alone.
 *
 * A raster stored with a `null` key is drawable but never current, so the next
 * request makes it again. An animated raster is only right near
 * the moment it was made, so during playback it is dropped once its clip is
 * off screen (`keepAnimated`): drawn on the clip's next appearance, it was the
 * outro of the previous pass at the start of the next.
 *
 * Bounded: a clip that leaves the document is dropped by `retain`, and the map
 * never holds more than `CAPACITY` clips whatever happens.
 */

export const CAPACITY = 64;

type Entry = { key: string | null; raster: CanvasImageSource; static: boolean };

export class PreviewRasters {
  private entries = new Map<string, Entry>();
  private scales = new Map<string, number>();

  latest(elementId: string): CanvasImageSource | null {
    return this.entries.get(elementId)?.raster ?? null;
  }

  keyOf(elementId: string): string | null {
    return this.entries.get(elementId)?.key ?? null;
  }

  put(elementId: string, key: string | null, raster: CanvasImageSource, isStatic = false): void {
    this.entries.delete(elementId);
    this.entries.set(elementId, { key, raster, static: isStatic });
    while (this.entries.size > CAPACITY) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** Recorded by the renderer; read by the next preview rasterisation. */
  noteScale(elementId: string, scale: number): void {
    if (Number.isFinite(scale) && scale > 0) {
      this.scales.set(elementId, scale);
    }
  }

  scaleOf(elementId: string): number {
    return this.scales.get(elementId) ?? 1;
  }

  /** Forget every clip not in `live`. */
  retain(live: ReadonlySet<string>): void {
    for (const id of [...this.entries.keys()]) {
      if (!live.has(id)) {
        this.entries.delete(id);
      }
    }
    for (const id of [...this.scales.keys()]) {
      if (!live.has(id)) {
        this.scales.delete(id);
      }
    }
  }

  /** Drop every animated raster whose clip is not in `onScreen`; static ones stay. */
  keepAnimated(onScreen: ReadonlySet<string>): void {
    for (const [id, entry] of [...this.entries]) {
      if (!entry.static && !onScreen.has(id)) {
        this.entries.delete(id);
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.scales.clear();
  }
}

export const previewRasters = new PreviewRasters();
