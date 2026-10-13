import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../../@types/timeline";
import {
  groupElement,
  imageElement,
  shapeElement,
  transitionElement,
} from "../renderer/testing";
import { elementRefsOf, renameElementRefs } from "./elementRefs";

/**
 * The list of fields that name another element. Every renamer in the codebase
 * goes through this one function, so each field it knows is pinned here, and
 * the identity path is pinned for the element that names nothing.
 */

const link = (elementId: string) => ({
  from: { elementId, property: "rotation" as const },
  in: [0, 360],
  out: [0, 1],
});

const upper = (id: string) => id.toUpperCase();

describe("renameElementRefs", () => {
  it("returns its input by identity when the element names nothing", () => {
    const element = shapeElement();
    expect(renameElementRefs(element, upper)).toBe(element);
  });

  it("returns its input by identity when every name maps to itself", () => {
    const element = imageElement({
      parentId: "g",
      link: { opacity: link("src") },
    } as never);
    expect(renameElementRefs(element, (id) => id)).toBe(element);
  });

  it("renames a parent", () => {
    const element = imageElement({ parentId: "g" });
    const next = renameElementRefs(element, upper);
    expect(next.parentId).toBe("G");
    expect(element.parentId).toBe("g");
  });

  it("removes a parent whose target is gone, rather than storing null", () => {
    const element = imageElement({ parentId: "g" });
    const next = renameElementRefs(element, () => null);
    expect("parentId" in next).toBe(false);
  });

  it("renames every link entry and leaves the rest of the link alone", () => {
    const element = imageElement({
      link: { opacity: link("a"), rotation: link("b") },
    } as never) as TimelineElement & { link: any };
    const next = renameElementRefs(element, upper) as typeof element;
    expect(next.link.opacity.from.elementId).toBe("A");
    expect(next.link.rotation.from.elementId).toBe("B");
    expect(next.link.opacity.in).toBe(element.link.opacity.in);
    expect(next.link.opacity.from.property).toBe("rotation");
    expect(element.link.opacity.from.elementId).toBe("a");
  });

  it("drops a link entry whose source is gone, and the key once empty", () => {
    const element = imageElement({
      link: { opacity: link("a"), rotation: link("b") },
    } as never) as TimelineElement & { link: any };
    const partly = renameElementRefs(element, (id) =>
      id === "a" ? null : id,
    ) as typeof element;
    expect(Object.keys(partly.link)).toEqual(["rotation"]);

    const none = renameElementRefs(element, () => null);
    expect("link" in none).toBe(false);
  });

  it("renames a transition's two clips", () => {
    const element = transitionElement({ fromId: "a", toId: "b" });
    const next = renameElementRefs(element, upper);
    expect(next.fromId).toBe("A");
    expect(next.toId).toBe("B");
  });

  it("leaves a transition's required endpoints alone when the target is gone", () => {
    const element = transitionElement({ fromId: "a", toId: "b" });
    expect(renameElementRefs(element, () => null)).toBe(element);
  });

  it("does not read fromId/toId on anything but a transition", () => {
    const element = groupElement({ fromId: "a" } as never);
    expect(renameElementRefs(element, upper)).toBe(element);
  });
});

describe("elementRefsOf", () => {
  it("lists every reference an element holds", () => {
    expect(
      elementRefsOf(
        imageElement({
          parentId: "g",
          link: { opacity: link("a") },
        } as never),
      ).sort(),
    ).toEqual(["a", "g"]);
    expect(elementRefsOf(transitionElement({ fromId: "x", toId: "y" }))).toEqual(
      ["x", "y"],
    );
    expect(elementRefsOf(shapeElement())).toEqual([]);
  });
});
