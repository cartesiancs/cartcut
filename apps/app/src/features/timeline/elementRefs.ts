/**
 * The fields on an element that name another element, and the one way to
 * rename them.
 *
 * Three callers rename a whole document's ids at once and each used to know
 * its own subset of these fields. `template/compose.ts` namespaces a placed
 * template's contents as `outerId::innerKey`, and rewrote `parentId` but not
 * a property link, so a link authored inside a template looked its source up
 * under the bare key, found nothing, and silently fell back to the static
 * value in the composite. `composition/rekey.ts` gives a forked template fresh
 * ids. A field added to this list reaches both.
 *
 * The list, against `@types/timeline.ts`: `parentId` (a transform parent),
 * every entry of `link` (`PropertyLink.from.elementId`), and a transition's
 * `fromId` and `toId`. `key` and `trackId` are not references to another
 * element and stay with their callers.
 *
 * Pure, DOM-free and store-free.
 */

import type { TimelineElement } from "../../@types/timeline";

/**
 * Where a reference should point now.
 *
 * `null` means the element it named is not in the result. A `parentId` or a
 * link entry is then removed, which is what `repairHierarchy` would do to a
 * dangling parent and what `linkOf` would make of a missing source anyway. A
 * transition's `fromId`/`toId` are required fields and are left as they were:
 * `repairTransitions` drops a transition whose clip is gone wherever it runs.
 */
export type RenameRef = (elementId: string) => string | null;

function renamedLinks(
  links: unknown,
  rename: RenameRef,
): { changed: boolean; value: Record<string, unknown> | undefined } {
  if (links == null || typeof links !== "object" || Array.isArray(links)) {
    return { changed: false, value: links as undefined };
  }
  const entries = links as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const property of Object.keys(entries)) {
    const link = entries[property];
    const from = (link as { from?: { elementId?: unknown } } | null)?.from;
    const source = from?.elementId;
    if (typeof source !== "string" || source === "") {
      next[property] = link;
      continue;
    }
    const target = rename(source);
    if (target == null) {
      changed = true;
      continue;
    }
    if (target === source) {
      next[property] = link;
      continue;
    }
    changed = true;
    next[property] = {
      ...(link as object),
      from: { ...(from as object), elementId: target },
    };
  }
  if (!changed) {
    return { changed: false, value: entries };
  }
  return {
    changed: true,
    value: Object.keys(next).length === 0 ? undefined : next,
  };
}

/**
 * This element with every reference to another element renamed.
 *
 * Returns its input **by identity** when nothing it names changes, so a
 * document with no parents, links or transitions costs one pass and no
 * allocation.
 */
export function renameElementRefs<T extends TimelineElement>(
  element: T,
  rename: RenameRef,
): T {
  let next: Record<string, unknown> | null = null;
  const write = (key: string, value: unknown) => {
    next ??= { ...(element as object) };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  };

  const parentId = (element as { parentId?: unknown }).parentId;
  if (typeof parentId === "string" && parentId !== "") {
    const target = rename(parentId);
    if (target !== parentId) {
      write("parentId", target ?? undefined);
    }
  }

  const links = renamedLinks((element as { link?: unknown }).link, rename);
  if (links.changed) {
    write("link", links.value);
  }

  if (element.filetype === "transition") {
    for (const key of ["fromId", "toId"] as const) {
      const id = (element as unknown as Record<string, unknown>)[key];
      if (typeof id !== "string" || id === "") {
        continue;
      }
      const target = rename(id);
      if (target != null && target !== id) {
        write(key, target);
      }
    }
  }

  return (next ?? element) as T;
}

/** Every element id this element names, for tests and integrity checks. */
export function elementRefsOf(element: TimelineElement): string[] {
  const out: string[] = [];
  renameElementRefs(element, (id) => {
    out.push(id);
    return id;
  });
  return out;
}
