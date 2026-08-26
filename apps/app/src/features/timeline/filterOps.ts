/**
 * Document-level edits to a clip's video filter.
 *
 * The stored shape is `filter: {enable, list}`, where each entry's parameters
 * are a positional `k=v:k=v` string whose *keys differ per filter* — chromakey
 * carries `r=…:g=…:b=…:f=…`, the blurs carry `f=…`. That is the whole reason
 * this file exists rather than a `setIn(element, ["filter", "list", i, "name"])`
 * at each call site: changing only the name leaves the previous filter's string
 * behind, and the shaders read it anyway. `f=5` read as a chromakey is a
 * threshold of 5, and `distance() < 5` is always true, so the clip renders
 * fully transparent — a filter switch that makes the video disappear.
 *
 * So these ops take a **structured** `FilterInput` and encode through
 * `toFilter`, which seeds each filter's own defaults. Switching type therefore
 * re-seeds the parameters instead of reinterpreting the old ones.
 *
 * `enable` and `list` are set separately because the panel offers them
 * separately — "Enable Filter" is its own button from "Add Filter" — and
 * because toggling the switch should not discard the parameters underneath it.
 *
 * Both return the document **by identity** when they change nothing, the
 * contract every op in `clipOps` holds: `withCheckpoint` reads identity to mean
 * "nothing happened" and records no undo step, so re-picking the filter a clip
 * already has costs the user nothing.
 */

import type { TimelineElement, VideoElementType } from "../../@types/timeline";
import { setIn } from "../../utils/immutable";
import {
  describeFilter,
  toFilter,
  type FilterInput,
} from "../renderer/filter/params";
import type { TimelineDocument } from "./tracks";

/**
 * The clip's current filter, structured, or `null` when it carries none.
 *
 * The inverse of `toFilter`, so a panel can bind its colour picker and its
 * strength field to what is actually stored rather than to a hardcoded default
 * that silently disagrees with it.
 */
export function filterOf(
  element: TimelineElement | undefined,
): FilterInput | null {
  const list = (element as VideoElementType | undefined)?.filter?.list;
  if (list == null || list.length === 0) {
    return null;
  }
  return describeFilter(list[0]) as FilterInput;
}

/** Whether a clip's filters are switched on. */
export function isFilterEnabled(element: TimelineElement | undefined): boolean {
  return (element as VideoElementType | undefined)?.filter?.enable === true;
}

/** Only video clips carry filters; nothing else has a `filter` field to set. */
function videoAt(
  doc: TimelineDocument,
  elementId: string,
): VideoElementType | null {
  const element = doc.elements[elementId];
  if (element == null || element.filetype !== "video") {
    return null;
  }
  return element as VideoElementType;
}

/**
 * Set the filter a clip carries, or clear it with `null`.
 *
 * The list holds at most one entry: that is what the panel offers — its "Add
 * Filter" button hides once one exists — and what `set_video_filters` writes.
 * The data model is a list because the pipeline chains them, so a second entry
 * would render; nothing authors one yet.
 *
 * Declines when the clip already carries exactly this filter, compared on the
 * *encoded* value so that two spellings of the same colour do not record a step.
 */
export function setVideoFilter(
  doc: TimelineDocument,
  elementId: string,
  filter: FilterInput | null,
): TimelineDocument {
  const element = videoAt(doc, elementId);
  if (element == null) {
    return doc;
  }

  // Encoded before anything is written, so an unparseable colour throws rather
  // than half-applying: `toFilter` validates the hex.
  const list = filter == null ? [] : [toFilter(filter)];
  const current = element.filter?.list ?? [];

  if (
    current.length === list.length &&
    current.every(
      (entry, i) => entry.name === list[i].name && entry.value === list[i].value,
    )
  ) {
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: setIn(element, ["filter", "list"], list),
    },
  };
}

/**
 * Switch a clip's filters on or off, keeping the parameters underneath.
 *
 * Separate from `setVideoFilter` so that turning the effect off to compare it
 * with the original, then back on, is two undo steps and no lost settings.
 */
export function setFilterEnabled(
  doc: TimelineDocument,
  elementId: string,
  enable: boolean,
): TimelineDocument {
  const element = videoAt(doc, elementId);
  if (element == null) {
    return doc;
  }
  if (isFilterEnabled(element) === enable) {
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: setIn(element, ["filter", "enable"], enable),
    },
  };
}
