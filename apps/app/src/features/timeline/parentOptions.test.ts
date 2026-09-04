import { describe, it, expect } from "vitest";
import {
  canPickParent,
  parentChoicesFor,
  sharedParentOf,
} from "./parentOptions";
import { setParent } from "./groupOps";
import { MAX_GROUP_DEPTH } from "./hierarchy";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { audioElement, groupElement, imageElement } from "../renderer/testing";

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      createTrack("v1", "video", 0),
      createTrack("g1", "group", 1),
      createTrack("a1", "audio", 2),
    ],
    elements,
  });
}

/** A chain of `depth` nested groups, `n0` at the root. */
function nested(depth: number) {
  const elements: Record<string, any> = {};
  for (let i = 0; i < depth; i++) {
    elements[`n${i}`] = groupElement({
      name: `N${i}`,
      trackId: "g1",
      ...(i > 0 ? { parentId: `n${i - 1}` } : {}),
    } as any);
  }
  return elements;
}

const ids = (choices: { id: string }[]) => choices.map((c) => c.id);
const byId = (choices: any[], id: string) => choices.find((c) => c.id === id);

describe("parentChoicesFor", () => {
  it("lists every group in the document", () => {
    const d = doc({
      a: groupElement({ name: "A", trackId: "g1" } as any),
      b: groupElement({ name: "B", trackId: "g1" } as any),
      img: imageElement({ trackId: "v1" }),
    });
    expect(ids(parentChoicesFor(d.elements, ["img"]))).toEqual(["a", "b"]);
  });

  it("offers no ordinary clip as a parent", () => {
    // `hierarchy.ts#parentOf` admits only a group, so a link to an image is not
    // a link at all — it would be dropped by `repairHierarchy` on the next
    // edit, leaving the user with a setting that silently un-set itself.
    const d = doc({
      img: imageElement({ trackId: "v1" }),
      other: imageElement({ trackId: "v1", startTime: 5000 }),
    });
    expect(parentChoicesFor(d.elements, ["img"])).toEqual([]);
  });

  it("marks the element's own row as self rather than hiding it", () => {
    // Hiding it would make the list shift under the pointer as the selection
    // changes. Showing it disabled says *why* it cannot be chosen.
    const d = doc({ g: groupElement({ name: "G", trackId: "g1" } as any) });
    const self = byId(parentChoicesFor(d.elements, ["g"]), "g");
    expect(self.disabled).toBe(true);
    expect(self.reason).toBe("self");
  });

  it("marks a descendant as a cycle", () => {
    // Dragging a folder into itself. `wouldCycle` is the same check
    // `setParent` runs, deliberately.
    const d = doc({
      parent: groupElement({ name: "P", trackId: "g1" } as any),
      child: groupElement({
        name: "C",
        trackId: "g1",
        parentId: "parent",
      } as any),
    });
    const choice = byId(parentChoicesFor(d.elements, ["parent"]), "child");
    expect(choice.disabled).toBe(true);
    expect(choice.reason).toBe("cycle");
  });

  it("marks a parent that would breach the depth cap", () => {
    // `MAX_GROUP_DEPTH` is the deepest an element may *sit*, not the longest
    // chain of groups, so a leaf landing exactly on it is fine and the group
    // one further down is the first that is not. Both boundaries are asserted
    // because an off-by-one here would show up as a picker refusing a nesting
    // the op accepts, which reads as a bug in the op.
    const atCap = doc({
      ...nested(MAX_GROUP_DEPTH), // n0..n7, deepest sits at depth 7
      img: imageElement({ trackId: "v1" }),
    });
    const allowed = parentChoicesFor(atCap.elements, ["img"]);
    expect(byId(allowed, `n${MAX_GROUP_DEPTH - 1}`).disabled).toBe(false);

    const overCap = doc({
      ...nested(MAX_GROUP_DEPTH + 1), // n8 sits at depth 8, the cap itself
      img: imageElement({ trackId: "v1" }),
    });
    const choices = parentChoicesFor(overCap.elements, ["img"]);
    expect(byId(choices, `n${MAX_GROUP_DEPTH}`).disabled).toBe(true);
    expect(byId(choices, `n${MAX_GROUP_DEPTH}`).reason).toBe("depth");
    expect(byId(choices, "n0").disabled).toBe(false);
  });

  it("measures the depth the moved subtree needs, not just the element's own", () => {
    // A group carrying a tall subtree can slide under the cap on the strength
    // of its root; `subtreeHeight` is what stops it, and `setParent` uses it.
    const d = doc({
      ...nested(3), // n0 > n1 > n2, so n0's subtree is 2 tall
      host: groupElement({ name: "H", trackId: "g1" } as any),
    });
    const choices = parentChoicesFor(d.elements, ["n0"]);
    expect(byId(choices, "host").disabled).toBe(false);
    // The three in the chain are all self-or-descendant.
    expect(byId(choices, "n1").reason).toBe("cycle");
  });

  it("reports how deep each group sits, so the list can read as a tree", () => {
    const d = doc({ ...nested(3), img: imageElement({ trackId: "v1" }) });
    const choices = parentChoicesFor(d.elements, ["img"]);
    expect(byId(choices, "n0").depth).toBe(0);
    expect(byId(choices, "n1").depth).toBe(1);
    expect(byId(choices, "n2").depth).toBe(2);
  });

  it("orders shallowest first, then by name, then by id", () => {
    const d = doc({
      zebra: groupElement({ name: "Zebra", trackId: "g1" } as any),
      apple: groupElement({ name: "Apple", trackId: "g1" } as any),
      deep: groupElement({
        name: "Aardvark",
        trackId: "g1",
        parentId: "zebra",
      } as any),
      img: imageElement({ trackId: "v1" }),
    });
    expect(ids(parentChoicesFor(d.elements, ["img"]))).toEqual([
      "apple",
      "zebra",
      "deep",
    ]);
  });

  it("carries the group's name, falling back to its id", () => {
    const d = doc({
      named: groupElement({ name: "Camera rig", trackId: "g1" } as any),
      blank: groupElement({ name: "", trackId: "g1" } as any),
      img: imageElement({ trackId: "v1" }),
    });
    const choices = parentChoicesFor(d.elements, ["img"]);
    expect(byId(choices, "named").name).toBe("Camera rig");
    expect(byId(choices, "blank").name).toBe("blank");
  });

  it("is empty for a selection nothing can be done with", () => {
    const d = doc({
      g: groupElement({ name: "G", trackId: "g1" } as any),
      sound: audioElement({ trackId: "a1" }),
    });
    expect(parentChoicesFor(d.elements, [])).toEqual([]);
    expect(parentChoicesFor(d.elements, ["sound"])).toEqual([]);
    expect(parentChoicesFor(d.elements, ["gone"])).toEqual([]);
  });

  it("takes the whole selection into account, not just the first", () => {
    // All-or-nothing, because `setParent` is: a partial re-parent would split a
    // selection across two coordinate spaces.
    const d = doc({
      host: groupElement({ name: "H", trackId: "g1" } as any),
      inner: groupElement({
        name: "I",
        trackId: "g1",
        parentId: "host",
      } as any),
      img: imageElement({ trackId: "v1" }),
    });
    // `host` is fine for the image but a cycle for `inner`'s ancestor chain.
    expect(byId(parentChoicesFor(d.elements, ["img"]), "host").disabled).toBe(
      false,
    );
    expect(
      byId(parentChoicesFor(d.elements, ["img", "host"]), "host").disabled,
    ).toBe(true);
  });
});

describe("the contract with setParent", () => {
  /**
   * The reason this module exists rather than the dropdown asking `setParent`
   * directly: the picker must never offer a choice the op refuses, and the only
   * way to keep the two from drifting is to assert them against each other.
   */
  const cases: Array<[string, TimelineDocument, string[]]> = [
    [
      "a flat document",
      doc({
        a: groupElement({ name: "A", trackId: "g1" } as any),
        b: groupElement({ name: "B", trackId: "g1" } as any),
        img: imageElement({ trackId: "v1" }),
      }),
      ["img"],
    ],
    [
      "a nested chain",
      doc({ ...nested(4), img: imageElement({ trackId: "v1" }) }),
      ["img"],
    ],
    [
      "a group being re-parented",
      doc({ ...nested(3), spare: groupElement({ name: "S", trackId: "g1" } as any) }),
      ["n0"],
    ],
    [
      "at the depth cap",
      doc({
        ...nested(MAX_GROUP_DEPTH),
        img: imageElement({ trackId: "v1" }),
      }),
      ["img"],
    ],
    [
      "past the depth cap",
      doc({
        ...nested(MAX_GROUP_DEPTH + 1),
        img: imageElement({ trackId: "v1" }),
      }),
      ["img"],
    ],
    [
      "a multi-clip selection",
      doc({
        ...nested(2),
        one: imageElement({ trackId: "v1" }),
        two: imageElement({ trackId: "v1", startTime: 5000 }),
      }),
      ["one", "two"],
    ],
  ];

  it.each(cases)(
    "every enabled choice is one setParent accepts — %s",
    (_label, d, selection) => {
      const held = sharedParentOf(d.elements, selection);
      const choices = parentChoicesFor(d.elements, selection);
      expect(choices.length).toBeGreaterThan(0);

      for (const choice of choices) {
        // Selecting the parent already held is a no-op, which `setParent`
        // declines by identity for a different reason than illegality.
        if (choice.id === held) {
          expect(choice.disabled).toBe(false);
          continue;
        }
        const accepted = setParent(d, selection, choice.id, 0) !== d;
        expect(
          accepted,
          `${choice.id} disabled=${choice.disabled} reason=${choice.reason}`,
        ).toBe(!choice.disabled);
      }
    },
  );
});

describe("sharedParentOf", () => {
  const d = doc({
    g: groupElement({ name: "G", trackId: "g1" } as any),
    h: groupElement({ name: "H", trackId: "g1" } as any),
    inG: imageElement({ trackId: "v1", parentId: "g" } as any),
    alsoInG: imageElement({ trackId: "v1", startTime: 5000, parentId: "g" } as any),
    inH: imageElement({ trackId: "v1", startTime: 9000, parentId: "h" } as any),
    loose: imageElement({ trackId: "v1", startTime: 12000 }),
  });

  it("is the parent when the selection agrees", () => {
    expect(sharedParentOf(d.elements, ["inG"])).toBe("g");
    expect(sharedParentOf(d.elements, ["inG", "alsoInG"])).toBe("g");
  });

  it("is null when the selection sits on the canvas", () => {
    expect(sharedParentOf(d.elements, ["loose"])).toBeNull();
  });

  it("is mixed when the selection disagrees", () => {
    // The picker shows a blank rather than picking a side, so that opening it
    // and closing it again cannot silently re-parent half a selection.
    expect(sharedParentOf(d.elements, ["inG", "inH"])).toBe("mixed");
    expect(sharedParentOf(d.elements, ["inG", "loose"])).toBe("mixed");
  });

  it("is null for a selection that names nothing live", () => {
    expect(sharedParentOf(d.elements, [])).toBeNull();
    expect(sharedParentOf(d.elements, ["gone"])).toBeNull();
  });
});

describe("canPickParent", () => {
  const d = doc({
    g: groupElement({ name: "G", trackId: "g1" } as any),
    img: imageElement({ trackId: "v1" }),
    sound: audioElement({ trackId: "a1" }),
  });

  it("is true for anything with a picture to place", () => {
    expect(canPickParent(d.elements, ["img"])).toBe(true);
    expect(canPickParent(d.elements, ["g"])).toBe(true);
  });

  it("is false for audio, which has no picture for a transform to move", () => {
    expect(canPickParent(d.elements, ["sound"])).toBe(false);
    expect(canPickParent(d.elements, ["img", "sound"])).toBe(false);
  });

  it("is false for an empty or dead selection", () => {
    expect(canPickParent(d.elements, [])).toBe(false);
    expect(canPickParent(d.elements, ["gone"])).toBe(false);
  });
});
