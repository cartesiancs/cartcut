/**
 * Text clips back out as cues.
 *
 * The other half of `importCues.ts`, and it shares no code with it beyond
 * `SubtitleCue` itself. That is what makes the round-trip test in
 * `exportCues.test.ts` worth having: it is the only thing that can catch the two
 * halves agreeing on nothing.
 *
 * ## `spanOf`, never `element.duration`
 *
 * `spanLength` is the function that knows `duration` means source milliseconds
 * on a dynamic element and timeline milliseconds on a static one. A text clip is
 * static, so today the two happen to agree and open-coding `element.duration`
 * would pass every test. It is still wrong to write: the distinction is
 * `geometry.ts`'s to own, and `spanOf` is what CLAUDE.md names as the only way
 * to ask how much timeline a clip covers.
 *
 * ## Overlapping clips become overlapping cues
 *
 * Not merged. Both formats permit overlap and every player handles it, whereas
 * merging two clips into one cue would invent a line break the user never typed
 * and make the export disagree with the picture. Sorted by start and then end, so
 * the file is deterministic rather than dependent on the element map's order.
 *
 * ## Only `filetype: "text"`
 *
 * A template's inner text is a reference resolved at draw time, so there is no
 * string here to read (`templateRegistry` owns it), and a group draws nothing.
 * Neither is a silent omission worth warning about: a user exporting subtitles
 * is asking about their subtitles.
 */

import type { TextElementType } from "../../@types/timeline";
import { spanOf } from "../timeline/geometry";
import type { TimelineDocument } from "../timeline/tracks";
import { normalizeCues, type SubtitleCue } from "./cues";

export type SubtitleExportScope =
  | { kind: "all" }
  | { kind: "elements"; ids: readonly string[] };

/**
 * What the user meant by whatever they had selected.
 *
 * A selection holding text clips means those clips; anything else means the
 * whole project. The asymmetry is the point: selecting a video clip and asking
 * for subtitles should not hand back an empty file, because nothing about that
 * selection says the user wanted to narrow the export.
 */
export function exportScopeFor(
  doc: TimelineDocument,
  selection: readonly string[],
): SubtitleExportScope {
  const text = selection.filter((id) => isTextElement(doc, id));
  return text.length > 0 ? { kind: "elements", ids: text } : { kind: "all" };
}

export function cuesFromDocument(
  doc: TimelineDocument,
  scope: SubtitleExportScope,
): SubtitleCue[] {
  // A set, because an `elements` scope is a caller's list and a repeated id
  // would write the same cue twice. `exportScopeFor` cannot produce one, but a
  // caller assembling a scope by hand easily can.
  const ids = new Set(
    scope.kind === "all" ? Object.keys(doc.elements) : scope.ids,
  );

  const cues: SubtitleCue[] = [];
  for (const id of ids) {
    if (!isTextElement(doc, id)) {
      continue;
    }
    const element = doc.elements[id] as TextElementType;
    const span = spanOf(element);
    cues.push({ startMs: span.start, endMs: span.end, text: element.text });
  }

  // Sorts, clamps and drops the empty ones. A text clip with no words is
  // invisible on the timeline too, so it has nothing to say in a file either.
  return normalizeCues(cues);
}

function isTextElement(doc: TimelineDocument, id: string): boolean {
  return doc.elements[id]?.filetype === "text";
}
