/**
 * A composition, as the template renderer reads one.
 *
 * `renderer/template.ts` draws whatever `templateFor` answers, and it memoizes
 * its composed map on the identity of that answer (`compositionFor`). So the
 * answer for a composition has to be **stable while nothing changed** and new
 * the moment its content does. Content is immutable by convention and every
 * edit replaces the element map, so the map's identity is the key.
 *
 * Pure, DOM-free and store-free.
 */

import type { Timeline } from "../../@types/timeline";
import type { TemplateData } from "../template/compose";
import { slotsOf } from "../template/slots";
import {
  compositionExtentMs,
  projectTemplateId,
  type CompositionMeta,
  type TimelineContent,
} from "./project";

const memo = new WeakMap<
  Timeline,
  { meta: CompositionMeta; tracks: unknown; data: TemplateData }
>();

export function compositionTemplateData(
  meta: CompositionMeta,
  content: TimelineContent,
): TemplateData {
  const hit = memo.get(content.elements);
  if (hit != null && hit.meta === meta && hit.tracks === content.tracks) {
    return hit.data;
  }
  const data: TemplateData = {
    id: projectTemplateId(meta.id),
    name: meta.name,
    size: { w: meta.size.w, h: meta.size.h },
    durationMs: compositionExtentMs(content.elements),
    elements: content.elements,
    tracks: content.tracks,
    slots: slotsOf(content.elements),
  };
  memo.set(content.elements, { meta, tracks: content.tracks, data });
  return data;
}
