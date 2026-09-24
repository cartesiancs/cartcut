/**
 * Property links at the document level.
 *
 * Two claims the rest of the app depends on without naming them:
 *
 * - **A clip nobody has linked saves byte-identically** to one written before
 *   the feature. `SCHEMA_VERSION` did not move, so that is the whole of the
 *   compatibility story, and it rests on the key being deleted rather than
 *   emptied.
 * - **A copy keeps pointing at the original source.** Duplicating a card on a
 *   wheel must give a card that follows the same null, not one that follows a
 *   copy of it that does not exist.
 */

import { describe, expect, it } from "vitest";

import { linkOf } from "../animation/link";
import { imageElement, audioElement } from "../renderer/testing";
import { pasteClips, splitClip } from "./clipOps";
import {
  clearClipLink,
  isLinkable,
  linkedPropertiesOf,
  sameLink,
  setClipLink,
  wouldCycle,
} from "./linkOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";

const FADE = {
  from: { elementId: "spin", property: "rotation" },
  in: [-90, 0, 90],
  out: [0, 100, 0],
};

function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0), createTrack("a0", "audio", 1)],
    elements: {
      spin: {
        ...imageElement({ trackId: "v0", startTime: 0, duration: 8000 }),
        filetype: "group",
        rotation: 0,
      } as any,
      card: imageElement({ trackId: "v0", startTime: 0, duration: 8000 }),
      sound: audioElement({ trackId: "a0", startTime: 0, duration: 8000 }),
    },
  });
}

describe("setClipLink", () => {
  it("writes a link and reads it back", () => {
    const next = setClipLink(doc(), "card", "opacity", FADE);
    expect(linkOf(next.elements.card, "opacity")).toMatchObject({
      from: { elementId: "spin", property: "rotation" },
    });
  });

  it("declines by identity for a clip that cannot carry one", () => {
    const before = doc();
    // `toBe`, never `toEqual`: the contract is identity, and `toEqual` would
    // pass against a build that had lost it entirely.
    expect(setClipLink(before, "sound", "opacity", FADE)).toBe(before);
  });

  it("declines by identity for a source that is not there", () => {
    const before = doc();
    expect(
      setClipLink(before, "card", "opacity", {
        ...FADE,
        from: { elementId: "ghost", property: "rotation" },
      }),
    ).toBe(before);
  });

  it("declines by identity for a link already in force", () => {
    const once = setClipLink(doc(), "card", "opacity", FADE);
    expect(setClipLink(once, "card", "opacity", FADE)).toBe(once);
  });

  it("declines by identity for a shape the reader would refuse", () => {
    const before = doc();
    expect(setClipLink(before, "card", "opacity", { ...FADE, in: [0, 0] })).toBe(
      before,
    );
  });
});

describe("clearClipLink", () => {
  it("deletes the key rather than emptying it", () => {
    const linked = setClipLink(doc(), "card", "opacity", FADE);
    const cleared = clearClipLink(linked, "card", "opacity");

    // The whole compatibility story: a project linked and then unlinked has to
    // serialise exactly like one nobody ever linked.
    expect("link" in (cleared.elements.card as any)).toBe(false);
    expect(JSON.stringify(cleared.elements.card)).toBe(
      JSON.stringify(doc().elements.card),
    );
  });

  it("leaves the other links alone when one is named", () => {
    let next = setClipLink(doc(), "card", "opacity", FADE);
    next = setClipLink(next, "card", "scale", { ...FADE, out: [8, 12, 8] });
    next = clearClipLink(next, "card", "opacity");

    expect(linkedPropertiesOf(next.elements.card)).toEqual(["scale"]);
  });

  it("declines by identity when there is nothing to clear", () => {
    const before = doc();
    expect(clearClipLink(before, "card")).toBe(before);
  });
});

describe("wouldCycle", () => {
  it("catches a link that points back at itself", () => {
    expect(
      wouldCycle(doc().elements, "card", "opacity", {
        elementId: "card",
        property: "opacity",
      }),
    ).toBe(true);
  });

  it("catches a chain that closes", () => {
    const linked = setClipLink(doc(), "card", "opacity", {
      ...FADE,
      from: { elementId: "spin", property: "opacity" },
    });
    expect(
      wouldCycle(linked.elements, "spin", "opacity", {
        elementId: "card",
        property: "opacity",
      }),
    ).toBe(true);
  });

  it("allows a chain that does not", () => {
    expect(
      wouldCycle(doc().elements, "card", "opacity", {
        elementId: "spin",
        property: "rotation",
      }),
    ).toBe(false);
  });
});

describe("a link through a clip edit", () => {
  it("survives a duplicate, still pointing at the original source", () => {
    // The card wheel again: duplicating a card gives a card that follows the
    // same null. Rewriting the source id to a copy that does not exist is the
    // failure this pins against.
    const linked = setClipLink(doc(), "card", "opacity", FADE);
    let minted = 0;
    const next = pasteClips(
      linked,
      { card: linked.elements.card },
      4000,
      () => `copy${minted++}`,
    );

    const copies = Object.keys(next.elements).filter((id) =>
      id.startsWith("copy"),
    );
    expect(copies).toHaveLength(1);
    // `pasteClips` rewrites a `parentId` that names a clip inside the paste,
    // so that a duplicated group keeps its own children. A link's source is
    // deliberately *not* rewritten: the copy follows the same null.
    expect(linkOf(next.elements[copies[0]], "opacity")?.from.elementId).toBe(
      "spin",
    );
  });

  it("survives a split on both pieces", () => {
    const linked = setClipLink(doc(), "card", "opacity", FADE);
    const next = splitClip(linked, "card", 4000);

    for (const id of Object.keys(next.elements)) {
      if (id === "spin" || id === "sound") {
        continue;
      }
      expect(linkOf(next.elements[id], "opacity")?.from.elementId).toBe("spin");
    }
  });
});

describe("isLinkable and sameLink", () => {
  it("admits the types that resolve a transform per element", () => {
    const elements = doc().elements;
    expect(isLinkable(elements.card)).toBe(true);
    expect(isLinkable(elements.spin)).toBe(true);
    expect(isLinkable(elements.sound)).toBe(false);
    expect(isLinkable(null)).toBe(false);
  });

  it("tells two links apart", () => {
    expect(sameLink(null, null)).toBe(true);
    expect(sameLink(FADE as any, FADE as any)).toBe(true);
    expect(sameLink(FADE as any, { ...FADE, offset: 10 } as any)).toBe(false);
    expect(sameLink(FADE as any, null)).toBe(false);
  });
});
