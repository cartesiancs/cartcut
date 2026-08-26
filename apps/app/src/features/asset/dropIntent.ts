/**
 * What a drag carries, decided in one place.
 *
 * Two drop targets used to answer this question independently and disagree:
 * `<asset-upload-drop>` raised a full-window curtain on *every* `dragenter`
 * without looking at `dataTransfer.types` at all, and the timeline canvas
 * accepted only its own custom type. So dragging an asset out of the panel
 * raised the curtain, the curtain covered the canvas, and the drop the canvas
 * was waiting for went to the curtain instead — which then tried to read it as
 * an OS file and threw. Both halves of the feature were broken by the same
 * missing check.
 *
 * Now both consult this, so a curtain that appears and a canvas that accepts
 * cannot disagree about what is being dragged.
 */

/** The custom type an asset-panel drag carries: an absolute file path. */
export const ASSET_MIME = "application/x-cartcut-asset";

/** The type Chromium reports for a drag that came from outside the window. */
export const FILES_MIME = "Files";

/**
 * The custom type an fx-preset tile carries: a preset id.
 *
 * An id rather than a path, because a preset is a folder the registry already
 * has resolved — the drop target looks it up rather than reading the disk
 * again.
 */
export const FX_PRESET_MIME = "application/x-cartcut-fx-preset";

export type DropIntent =
  /** Files from the OS. `dataTransfer.files` has them. */
  | "os-files"
  /** An asset dragged out of the asset panel. `getData(ASSET_MIME)` has it. */
  | "asset"
  /** An effect or transition preset. `getData(FX_PRESET_MIME)` has its id. */
  | "fx-preset"
  /** Selected text, a link, anything the editor has no use for. */
  | "ignore";

/**
 * Classify a drag from its `dataTransfer.types`.
 *
 * The asset type is tested *first* on purpose. A drag that started inside the
 * app can still list `"Files"` alongside its own type, and reading `"Files"`
 * first is exactly the bug above: it would send an internal drag down the OS
 * import path, where `dataTransfer.files` is empty and nothing happens.
 */
export function dropIntent(types: readonly string[] | undefined): DropIntent {
  if (types == null) {
    return "ignore";
  }

  // Before the asset check for the same reason the asset check comes before
  // "Files": an internal drag can list several types, and the most specific one
  // is the one that describes what is actually being dragged.
  if (types.includes(FX_PRESET_MIME)) {
    return "fx-preset";
  }

  if (types.includes(ASSET_MIME)) {
    return "asset";
  }

  if (types.includes(FILES_MIME)) {
    return "os-files";
  }

  return "ignore";
}
