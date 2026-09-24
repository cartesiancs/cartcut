/**
 * Document-level edits to a clip's property links.
 *
 * The three rules `blendOps.ts` states hold here too: only some element types
 * can carry one, the default deletes the key rather than storing it, and
 * declining returns the document by identity so `withCheckpoint` records no
 * undo step.
 *
 * One rule is this module's own. **A link is never written without checking it
 * can be followed.** `setClipLink` refuses a source that is not in the document
 * and a link that would close a cycle, because the alternative is a link the
 * renderer silently ignores — which to the person who wrote it looks exactly
 * like the feature not working.
 */

import type {
  LinkableProperty,
  PropertyLink,
  Timeline,
  TimelineElement,
} from "../../@types/timeline";
import { LINKABLE_PROPERTIES } from "../../@types/timeline";
import {
  MAX_LINK_DEPTH,
  coerceLink,
  isLinkableProperty,
  linkOf,
} from "../animation/link";
import type { TimelineDocument } from "./tracks";

/**
 * The element types that can carry a link.
 *
 * The same ones that carry a transform the renderer resolves per element. An
 * effect and a transition are whole-frame operations with their own samplers,
 * and audio has no picture.
 */
export const LINKABLE_FILETYPES = [
  "video",
  "image",
  "shape",
  "text",
  "group",
  "template",
] as const;

const LINKABLE_TYPES = new Set<string>(LINKABLE_FILETYPES);

export function isLinkable(
  element: TimelineElement | null | undefined,
): boolean {
  return element != null && LINKABLE_TYPES.has(element.filetype);
}

/** Whether two links say the same thing. */
export function sameLink(
  a: PropertyLink | null | undefined,
  b: PropertyLink | null | undefined,
): boolean {
  if (a == null || b == null) {
    return (a ?? null) === (b ?? null);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether linking `elementId`'s `property` to `source` would close a cycle.
 *
 * Walks the links that would exist *after* the write, so a chain that is fine
 * today and closes with this edit is caught. `link.ts` also guards at read
 * time and falls back silently; this is the half that can say why.
 */
export function wouldCycle(
  elements: Timeline,
  elementId: string,
  property: LinkableProperty,
  source: { elementId: string; property: string },
): boolean {
  let atId = source.elementId;
  let atProperty = source.property;

  for (let depth = 0; depth <= MAX_LINK_DEPTH; depth += 1) {
    if (atId === elementId && atProperty === property) {
      return true;
    }
    if (!isLinkableProperty(atProperty)) {
      // A source that cannot itself be driven ends the chain.
      return false;
    }
    const onward = linkOf((elements as any)?.[atId], atProperty);
    if (onward == null) {
      return false;
    }
    atId = onward.from.elementId;
    atProperty = onward.from.property;
  }

  // Longer than anything that can be followed. Refusing is the honest answer:
  // the renderer would stop at the cap and the caller would see a link that
  // does nothing.
  return true;
}

/** The element with `link` written or removed. The single write path. */
function withLink(
  doc: TimelineDocument,
  elementId: string,
  property: LinkableProperty,
  next: PropertyLink | null,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isLinkable(element)) {
    return doc;
  }
  if (sameLink(linkOf(element, property), next)) {
    return doc;
  }

  const source = element as TimelineElement & {
    link?: Record<string, PropertyLink>;
  };
  const links: Record<string, PropertyLink> = { ...(source.link ?? {}) };

  if (next == null) {
    delete links[property];
  } else {
    links[property] = next;
  }

  let updated: TimelineElement;
  if (Object.keys(links).length === 0) {
    // Removed, not set to `undefined`. `JSON.stringify` drops an undefined and
    // `structuredClone`, which the copy path uses, keeps it, so a stored
    // `undefined` would make the saved project and the one in memory disagree
    // about whether the clip had ever been linked. `maskOps.ts` says the same.
    const { link: _cleared, ...rest } = source;
    updated = rest as TimelineElement;
  } else {
    updated = { ...source, link: links } as TimelineElement;
  }

  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Drive one clip's property from another's.
 *
 * Declines by identity for a clip that cannot carry a link, a link the reader
 * would refuse, a missing source, a cycle, and a link already in force.
 */
export function setClipLink(
  doc: TimelineDocument,
  elementId: string,
  property: LinkableProperty,
  link: unknown,
): TimelineDocument {
  const next = coerceLink(link);
  if (next == null) {
    return doc;
  }
  if (doc.elements[next.from.elementId] == null) {
    return doc;
  }
  if (wouldCycle(doc.elements, elementId, property, next.from)) {
    return doc;
  }
  return withLink(doc, elementId, property, next);
}

/** The same write across several clips, as one undo step. */
export function setClipLinkMany(
  doc: TimelineDocument,
  writes: ReadonlyArray<{
    elementId: string;
    property: LinkableProperty;
    link: unknown;
  }>,
): TimelineDocument {
  return writes.reduce(
    (next, write) => setClipLink(next, write.elementId, write.property, write.link),
    doc,
  );
}

/** Remove one property's link, or every link when `property` is omitted. */
export function clearClipLink(
  doc: TimelineDocument,
  elementId: string,
  property?: LinkableProperty,
): TimelineDocument {
  if (property != null) {
    return withLink(doc, elementId, property, null);
  }
  return LINKABLE_PROPERTIES.reduce(
    (next, one) => withLink(next, elementId, one, null),
    doc,
  );
}

/** Every property of this clip that is driven, in declaration order. */
export function linkedPropertiesOf(
  element: TimelineElement | null | undefined,
): LinkableProperty[] {
  return LINKABLE_PROPERTIES.filter((property) => linkOf(element, property) != null);
}
