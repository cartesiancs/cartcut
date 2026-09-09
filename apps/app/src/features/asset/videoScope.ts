/**
 * A named set of `<video>` handles, so two frame loops cannot seek or release
 * each other's decoders.
 *
 * The export's frame loop runs in the editor's own renderer and, until this
 * existed, drove the very same handles the preview does. The preview repaints
 * on every store write and its draw path calls `loadAssetsNeededAtTime`,
 * `syncPlayback` and `releaseUnusedVideos` *with a cursor* — all three of which
 * move or drop handles. `loadedAssetStore`'s own comment says an export "must
 * never have a handle taken away from under its frame loop", and the preview
 * did exactly that.
 *
 * The only thing that stopped it mattering was the progress dialog: a Bootstrap
 * modal with a backdrop over the whole window, which blocked the mouse. That is
 * not a property of the code, it was a property of the UI — and the export
 * button on the title bar removes it. Hence a scope.
 *
 * Only `<video>` needs one. Images and gifs are keyed by path and immutable
 * once decoded, so nothing can move one under a frame loop.
 *
 * DOM-free, and in its own module rather than inside `loadedAssetStore`,
 * because that file builds canvases at module load and therefore cannot be
 * imported under `environment: "node"` — see `assetBatch.ts`.
 */

/**
 * A decoded video, addressed by the element that asked for it.
 *
 * It deliberately holds **no copy of the element**. It used to, and because
 * every edit returns a new object while this entry was never refreshed, the
 * copy froze at load time — so a moved clip played footage offset by exactly
 * the drag distance. The live element is now passed in at every call site
 * instead, which makes that class of bug unrepresentable.
 */
export type VideoMetadataPerElement = {
  elementId: string;
  /** The source this was decoded from, so a changed path can be detected. */
  localpath: string;
  /**
   * The file this handle actually opened — the proxy when one is in use.
   *
   * Distinct from `localpath`, which stays the element's own path so every
   * other consumer is unaffected. Compared on each reconcile so that toggling
   * proxies, or a proxy finishing generation mid-session, rebuilds the handles
   * that are now pointing at the wrong rendition.
   */
  playbackPath: string;
  path: string;
  object: HTMLVideoElement;
};

export type VideoScope = {
  readonly id: string;
  readonly videos: Record<string, VideoMetadataPerElement>;
  /**
   * This scope's own in-flight set.
   *
   * Not shared with the preview's, and that is load-bearing rather than tidy:
   * `runAssetBatch` **skips** a task whose key is already in flight, so a clip
   * the preview had started decoding made `loadEntireTimeline` resolve with
   * that clip still missing from the export.
   */
  readonly loading: Set<string>;
  /** What each handle was last *asked* to go to. See `playback.ts#applyIntent`. */
  readonly lastSeekRequests: Map<string, number>;
};

export function createVideoScope(id: string): VideoScope {
  return {
    id,
    videos: {},
    loading: new Set(),
    lastSeekRequests: new Map(),
  };
}

let active: VideoScope | null = null;

/** The scope answering `getElementVideo` right now, or null for the shared set. */
export function activeVideoScope(): VideoScope | null {
  return active;
}

/**
 * Run `draw` with `scope` answering handle lookups.
 *
 * **`draw` must be synchronous.** Every renderer in the chain is — the whole of
 * `renderer/{timeline,element,video,image,gif,text,shape,template}.ts` and
 * `fx/compositor.ts` — which is what makes a dynamic extent safe here, and is
 * the only reason a template's *nested* video is covered without threading a
 * parameter through `ElementRenderFunction`. That matters because
 * `App.ts` installs one renderer table on the template resolver globally, so
 * swapping tables per caller would not reach a nested clip at all.
 *
 * The moment anything in that chain gains an `await`, the export's scope leaks
 * into whatever runs next and the preview starts drawing the export's frames.
 *
 * Restores the previous scope even when `draw` throws, so an aborted export
 * cannot leave the preview looking at handles that are about to be released.
 */
export function withVideoScope<T>(scope: VideoScope | null, draw: () => T): T {
  const previous = active;
  active = scope;
  try {
    return draw();
  } finally {
    active = previous;
  }
}
