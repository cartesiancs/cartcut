/**
 * Element classification: "static" vs "dynamic".
 *
 * This is the single implementation that drives visibility windowing across
 * preview and export. It was previously duplicated in `apps/app/src/utils/element.ts`,
 * `controllers/render.ts`, and `packages/render/src/offscreen-render.ts`
 * (the last one even re-declaring its own private copy). Now there is one.
 */

export type ElementKind = "undefined" | "static" | "dynamic";

const ELEMENT_FILE_EXTENSION_TYPE: Record<"static" | "dynamic", string[]> = {
  static: ["image", "text", "png", "jpg", "jpeg", "gif", "shape"],
  dynamic: ["video", "audio", "mp4", "mp3", "mov"],
};

export function getElementType(filetype: string | undefined): ElementKind {
  if (!filetype) return "undefined";
  for (const type of ["static", "dynamic"] as const) {
    if (ELEMENT_FILE_EXTENSION_TYPE[type].indexOf(filetype) >= 0) {
      return type;
    }
  }
  return "undefined";
}
