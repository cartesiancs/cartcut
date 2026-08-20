import { describe, it, expect } from "vitest";
import {
  MAX_GROUP_DEPTH,
  ancestorsOf,
  childrenOf,
  depthOf,
  descendantsOf,
  isGroupElement,
  parentOf,
  repairHierarchy,
  subtreeHeight,
  withDescendants,
  wouldCycle,
} from "./hierarchy";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import {
  audioElement,
  groupElement,
  imageElement,
} from "../renderer/testing";
import type { Timeline } from "../../@types/timeline";

function doc(elements: Record<string, any>): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [
      createTrack("v1", "video", 0),
      createTrack("g1", "group", 1),
      createTrack("a1", "audio", 2),
    ],
    elements,
  };
}

/** g -> a -> b, with a leaf clip under each group. */
function chain(): Timeline {
  return {
    g: groupElement({ trackId: "g1" }) as any,
    a: groupElement({ parentId: "g", trackId: "g1" }) as any,
    b: groupElement({ parentId: "a", trackId: "g1" }) as any,
    leaf: imageElement({ parentId: "b" }) as any,
    loose: imageElement({}) as any,
  };
}

describe("isGroupElement", () => {
  it("is true only for a group", () => {
    expect(isGroupElement(groupElement())).toBe(true);
    expect(isGroupElement(imageElement())).toBe(false);
    expect(isGroupElement(audioElement())).toBe(false);
    expect(isGroupElement(null)).toBe(false);
  });
});

describe("parentOf", () => {
  it("returns the parent when the link is good", () => {
    const elements = { g: groupElement(), c: imageElement({ parentId: "g" }) };
    expect(parentOf(elements as any, "c")).toBe("g");
  });

  it("is null when the element has no parentId", () => {
    expect(parentOf({ c: imageElement() } as any, "c")).toBeNull();
  });

  it("is null when the parent was deleted", () => {
    // Callers must never see a broken link, so an orphan simply reads as a
    // root and keeps rendering in canvas space.
    const elements = { c: imageElement({ parentId: "gone" }) };
    expect(parentOf(elements as any, "c")).toBeNull();
  });

  it("is null when the parent is not a group", () => {
    // Only groups may parent. A link to an ordinary clip is not a link.
    const elements = { p: imageElement(), c: imageElement({ parentId: "p" }) };
    expect(parentOf(elements as any, "c")).toBeNull();
  });

  it("is null when an element names itself", () => {
    const elements = { g: groupElement({ parentId: "g" }) };
    expect(parentOf(elements as any, "g")).toBeNull();
  });

  it("is null for an empty-string parentId", () => {
    const elements = { g: groupElement(), c: imageElement({ parentId: "" }) };
    expect(parentOf(elements as any, "c")).toBeNull();
  });

  it("is null for an element that is not in the map", () => {
    expect(parentOf({} as any, "nobody")).toBeNull();
  });
});

describe("ancestorsOf", () => {
  it("lists ancestors root first", () => {
    // Root first because that is the order the matrices multiply in.
    expect(ancestorsOf(chain(), "leaf")).toEqual(["g", "a", "b"]);
  });

  it("is empty for a root element", () => {
    expect(ancestorsOf(chain(), "loose")).toEqual([]);
    expect(ancestorsOf(chain(), "g")).toEqual([]);
  });

  it("terminates on a cycle instead of looping forever", () => {
    const elements: Timeline = {
      a: groupElement({ parentId: "b" }) as any,
      b: groupElement({ parentId: "a" }) as any,
    };
    expect(ancestorsOf(elements, "a").length).toBeLessThanOrEqual(
      MAX_GROUP_DEPTH,
    );
  });

  it("stops at the depth cap on a chain longer than it", () => {
    const elements: Timeline = {};
    for (let i = 0; i < MAX_GROUP_DEPTH + 5; i++) {
      elements[`g${i}`] = groupElement(
        i === 0 ? {} : { parentId: `g${i - 1}` },
      ) as any;
    }
    const deepest = `g${MAX_GROUP_DEPTH + 4}`;
    expect(ancestorsOf(elements, deepest)).toHaveLength(MAX_GROUP_DEPTH);
  });
});

describe("depthOf", () => {
  it("counts a root as zero", () => {
    expect(depthOf(chain(), "g")).toBe(0);
  });

  it("counts the groups above an element", () => {
    expect(depthOf(chain(), "leaf")).toBe(3);
  });
});

describe("childrenOf", () => {
  it("finds the direct children only", () => {
    expect(childrenOf(chain(), "g")).toEqual(["a"]);
  });

  it("is empty for a group with nothing in it", () => {
    expect(childrenOf({ g: groupElement() } as any, "g")).toEqual([]);
  });

  it("orders by id rather than by object key order", () => {
    // Key order is an implementation detail of whichever op last rebuilt the
    // map; a deterministic order keeps ops that iterate children reproducible.
    const elements: Timeline = {
      g: groupElement() as any,
      z: imageElement({ parentId: "g" }) as any,
      m: imageElement({ parentId: "g" }) as any,
      a: imageElement({ parentId: "g" }) as any,
    };
    expect(childrenOf(elements, "g")).toEqual(["a", "m", "z"]);
  });

  it("skips a child whose link does not resolve", () => {
    const elements: Timeline = {
      notagroup: imageElement() as any,
      c: imageElement({ parentId: "notagroup" }) as any,
    };
    expect(childrenOf(elements, "notagroup")).toEqual([]);
  });
});

describe("descendantsOf", () => {
  it("collects the whole subtree", () => {
    expect(descendantsOf(chain(), "g").sort()).toEqual(["a", "b", "leaf"]);
  });

  it("excludes the group itself", () => {
    expect(descendantsOf(chain(), "g")).not.toContain("g");
  });

  it("excludes an unrelated root clip", () => {
    expect(descendantsOf(chain(), "g")).not.toContain("loose");
  });

  it("returns no duplicates on a cyclic document", () => {
    const elements: Timeline = {
      a: groupElement({ parentId: "b" }) as any,
      b: groupElement({ parentId: "a" }) as any,
    };
    const found = descendantsOf(elements, "a");
    expect(new Set(found).size).toBe(found.length);
  });
});

describe("wouldCycle", () => {
  it("refuses an element as its own parent", () => {
    expect(wouldCycle(chain(), "g", "g")).toBe(true);
  });

  it("refuses parenting a group to its own descendant", () => {
    // The pick-whip equivalent of dragging a folder into itself.
    expect(wouldCycle(chain(), "g", "b")).toBe(true);
  });

  it("allows an unrelated group", () => {
    const elements: Timeline = {
      ...chain(),
      other: groupElement({ trackId: "g1" }) as any,
    };
    expect(wouldCycle(elements, "g", "other")).toBe(false);
  });

  it("allows parenting deeper into an unrelated branch", () => {
    expect(wouldCycle(chain(), "loose", "b")).toBe(false);
  });
});

describe("subtreeHeight", () => {
  it("is zero for a leaf", () => {
    expect(subtreeHeight(chain(), "loose")).toBe(0);
  });

  it("measures the tallest branch", () => {
    expect(subtreeHeight(chain(), "g")).toBe(3);
  });

  it("stops climbing at the cap on a cyclic document", () => {
    const elements: Timeline = {
      a: groupElement({ parentId: "b" }) as any,
      b: groupElement({ parentId: "a" }) as any,
    };
    expect(subtreeHeight(elements, "a")).toBeLessThanOrEqual(MAX_GROUP_DEPTH);
  });
});

describe("repairHierarchy", () => {
  it("returns the document by identity when no element has a parent", () => {
    // The fast path that makes it affordable inside `normalizeDocument`, which
    // runs on every edit. Every project without a group takes this path.
    const d = doc({ a: imageElement(), b: imageElement() });
    expect(repairHierarchy(d)).toBe(d);
  });

  it("returns the document by identity when every link is good", () => {
    const d = doc(chain());
    expect(repairHierarchy(d)).toBe(d);
  });

  it("drops a link to a deleted parent", () => {
    const d = doc({ c: imageElement({ parentId: "gone" }) });
    const out = repairHierarchy(d);
    expect(out).not.toBe(d);
    expect((out.elements.c as any).parentId).toBeUndefined();
  });

  it("drops a link to an element that is not a group", () => {
    const d = doc({ p: imageElement(), c: imageElement({ parentId: "p" }) });
    expect((repairHierarchy(d).elements.c as any).parentId).toBeUndefined();
  });

  it("drops a self-parent", () => {
    const d = doc({ g: groupElement({ parentId: "g" }) });
    expect((repairHierarchy(d).elements.g as any).parentId).toBeUndefined();
  });

  it("breaks a two-group cycle", () => {
    const d = doc({
      a: groupElement({ parentId: "b" }),
      b: groupElement({ parentId: "a" }),
    });
    const out = repairHierarchy(d);
    const stillLinked = ["a", "b"].filter(
      (id) => (out.elements[id] as any).parentId != null,
    );
    // At least one link has to go, or the cycle survives.
    expect(stillLinked.length).toBeLessThan(2);
  });

  it("leaves the good links alone while dropping a bad one", () => {
    const d = doc({
      ...chain(),
      broken: imageElement({ parentId: "nope" }),
    });
    const out = repairHierarchy(d);
    expect((out.elements.leaf as any).parentId).toBe("b");
    expect((out.elements.broken as any).parentId).toBeUndefined();
  });

  it("does not disturb any other field", () => {
    const d = doc({ c: imageElement({ parentId: "gone", startTime: 4321 }) });
    expect(out(d).startTime).toBe(4321);
    function out(input: TimelineDocument) {
      return repairHierarchy(input).elements.c as any;
    }
  });
});

describe("normalizeDocument runs the repair", () => {
  it("strips a dangling parentId on the way through", () => {
    // The invariant every consumer relies on: in a normalised document a
    // `parentId` names a live group or is absent.
    const out = normalizeDocument(doc({ c: imageElement({ parentId: "gone" }) }));
    expect((out.elements.c as any).parentId).toBeUndefined();
  });

  it("keeps deriving priorities", () => {
    const out = normalizeDocument(doc(chain()));
    expect(out.elements.leaf.priority).toBeGreaterThan(0);
  });

  it("still returns a well-formed document with no elements", () => {
    expect(normalizeDocument(doc({})).elements).toEqual({});
  });
});

describe("withDescendants", () => {
  it("expands a group into its whole subtree", () => {
    // What "delete a group" means: the contents go with it.
    expect(withDescendants(chain(), ["g"]).sort()).toEqual([
      "a",
      "b",
      "g",
      "leaf",
    ]);
  });

  it("leaves a plain clip alone", () => {
    expect(withDescendants(chain(), ["loose"])).toEqual(["loose"]);
  });

  it("deduplicates when a group and its child are both named", () => {
    expect(withDescendants(chain(), ["g", "leaf"]).sort()).toEqual([
      "a",
      "b",
      "g",
      "leaf",
    ]);
  });

  it("skips ids that are not in the document", () => {
    expect(withDescendants(chain(), ["ghost"])).toEqual([]);
  });
});
