/**
 * The ordinary timeline ops, pointed at a stabilize rig.
 *
 * Each of these used to treat the rig's groups as any other group: delete
 * took the footage with them, ungroup froze the camera at the playhead, split
 * left the footage holding the cut value, paste made a second camera under
 * the zoom. Every case here is one of those, asserting what happens now.
 */

import { describe, expect, it } from "vitest";
import { canPointerTarget } from "../preview/hitTest";
import { bakeTrack } from "../animation/keyframes";
import { groupElement, imageElement, keys } from "../renderer/testing";
import { deleteClips, pasteClips, rippleDelete, splitClip, trimClipEnd, trimClipStart } from "./clipOps";
import { isDurationLocked } from "./geometry";
import { canMergeClips, mergeClips } from "./mergeOps";
import { ungroupLoses } from "./groupOps";
import { rigOf } from "./rig";
import { riggedDoc } from "./rigTesting";
import { setTemplateFill } from "./templateOps";
import { normalizeDocument } from "./tracks";

const strip = ({ parentId: _p, priority: _q, ...rest }: any) => rest;

describe("deleting a rig", () => {
  it.each(["zoom", "cam"])("deleting the %s removes the stabilization and keeps the footage exactly", (id) => {
    const d = riggedDoc();
    const out = deleteClips(d, [id]);

    expect(out.elements.zoom).toBeUndefined();
    expect(out.elements.cam).toBeUndefined();
    expect(out.elements.foot.parentId).toBeUndefined();
    expect(out.elements.trk.parentId).toBeUndefined();
    expect(strip(out.elements.foot)).toEqual(strip(d.elements.foot));
    expect(strip(out.elements.trk)).toEqual(strip(d.elements.trk));
  });

  it("deletes the members named alongside, and keeps the rest", () => {
    const d = riggedDoc();
    const out = deleteClips(d, ["zoom", "foot"]);

    expect(out.elements.foot).toBeUndefined();
    expect(strip(out.elements.trk)).toEqual(strip(d.elements.trk));
  });

  it("still empties the timeline on select-all", () => {
    const d = riggedDoc();
    expect(Object.keys(deleteClips(d, Object.keys(d.elements)).elements)).toEqual([]);
  });

  it("still takes an ordinary group's contents with it", () => {
    const d = riggedDoc({
      box: groupElement({ key: "box", trackId: "gt", startTime: 9000 } as any),
      inBox: imageElement({ key: "inBox", trackId: "v1", startTime: 9000, parentId: "box" } as any),
    });
    const out = deleteClips(d, ["box"]);

    expect(out.elements.inBox).toBeUndefined();
    expect(out.elements.cam).toBeDefined();
  });

  it("ripple-deleting a rig bar dissolves it and moves nothing on its row", () => {
    const d = riggedDoc({
      later: groupElement({ key: "later", trackId: "gz", startTime: 6000 } as any),
    });
    const out = rippleDelete(d, "zoom");

    expect(out.elements.zoom).toBeUndefined();
    expect(out.elements.later.startTime).toBe(6000);
    expect(strip(out.elements.foot)).toEqual(strip(d.elements.foot));
  });

  it("declines a delete of nothing by identity, as before", () => {
    const d = riggedDoc();
    expect(deleteClips(d, ["nope"])).toBe(d);
  });
});

describe("a rig's bars hold their length", () => {
  it("is duration-locked, like a template and unlike a plain group", () => {
    const d = riggedDoc();
    expect(isDurationLocked(d.elements.zoom)).toBe(true);
    expect(isDurationLocked(d.elements.cam)).toBe(true);
    expect(isDurationLocked(d.elements.trk)).toBe(false);
    expect(isDurationLocked({ filetype: "template" } as any)).toBe(true);
    expect(isDurationLocked({ filetype: "group", rig: "something-else" } as any)).toBe(false);
  });

  it.each(["zoom", "cam"])("split and both trims decline on the %s", (id) => {
    const d = riggedDoc();
    expect(splitClip(d, id, 1000, "piece")).toBe(d);
    expect(trimClipStart(d, id, 200)).toBe(d);
    expect(trimClipEnd(d, id, -200)).toBe(d);
  });

  it("will not be joined to a bar beside it", () => {
    // Two marked cameras end to end on one row: what a split would have made.
    const d = riggedDoc({
      cam2: groupElement({
        key: "cam2",
        trackId: "gc",
        startTime: 4000,
        duration: 1000,
        rig: "stabilize-camera",
      } as any),
    });
    expect(canMergeClips(d, ["cam", "cam2"])).toBe(false);
    expect(mergeClips(d, ["cam", "cam2"])).toBe(d);
  });

  it("still splits the footage inside it, both halves staying in the camera", () => {
    const d = riggedDoc();
    const out = splitClip(d, "foot", 1000, "foot2");
    expect(out.elements.foot.parentId).toBe("cam");
    expect(out.elements.foot2.parentId).toBe("cam");
  });

  it("does not make a template op take a rig group for a template", () => {
    const d = riggedDoc();
    expect(setTemplateFill(d, "cam", "slot", { kind: "text", text: "x" } as any)).toBe(d);
  });
});

describe("pasting out of a rig", () => {
  let n = 0;
  const ids = () => `new${n++}`;
  const pasted = (before: any, after: any) =>
    Object.keys(after.elements).filter((id) => before.elements[id] == null);

  it("lands a lone footage copy at the root, as the unstabilized original", () => {
    const d = riggedDoc();
    const out = pasteClips(d, { foot: d.elements.foot }, 9000, ids);
    const [copy] = pasted(d, out);

    expect(out.elements[copy].parentId).toBeUndefined();
    expect(out.elements[copy].location).toEqual(d.elements.foot.location);
  });

  it("unmarks a rig group pasted without its partner", () => {
    const d = riggedDoc();
    for (const id of ["zoom", "cam"]) {
      const out = pasteClips(d, { [id]: d.elements[id] }, 9000, ids);
      const [copy] = pasted(d, out);
      expect((out.elements[copy] as any).rig).toBeUndefined();
      // And the original rig is still whole.
      expect(rigOf(out.elements, "foot")).toEqual({ zoomId: "zoom", cameraId: "cam" });
    }
  });

  it("makes a second working rig from a copy of the whole thing", () => {
    const d = riggedDoc();
    const out = pasteClips(
      d,
      { zoom: d.elements.zoom, cam: d.elements.cam, foot: d.elements.foot, trk: d.elements.trk },
      9000,
      ids,
    );
    const copies = pasted(d, out);
    const footCopy = copies.find((id) => out.elements[id].filetype === "image") as string;
    const rig = rigOf(out.elements, footCopy);

    expect(rig).not.toBeNull();
    expect(rig?.zoomId).not.toBe("zoom");
    expect(rigOf(out.elements, "foot")).toEqual({ zoomId: "zoom", cameraId: "cam" });
  });
});

describe("ungroupLoses", () => {
  it("is false for a rig group, which dissolves exactly", () => {
    const d = riggedDoc();
    expect(ungroupLoses(d.elements, "cam")).toBe(false);
    expect(ungroupLoses(d.elements, "zoom")).toBe(false);
  });

  it("is still true for an ordinary animated group, and false for a still one", () => {
    const x = keys([0, 0], [1000, 50]);
    const d = normalizeDocument({
      ...riggedDoc(),
      elements: {
        ...riggedDoc().elements,
        moving: groupElement({
          key: "moving",
          trackId: "gt",
          startTime: 9000,
          animation: {
            ...groupElement().animation,
            position: { isActivate: true, x, y: x, ax: bakeTrack(x), ay: bakeTrack(x) },
          },
        } as any),
        still: groupElement({ key: "still", trackId: "gt", startTime: 12000 } as any),
      },
    });
    expect(ungroupLoses(d.elements, "moving")).toBe(true);
    expect(ungroupLoses(d.elements, "still")).toBe(false);
    expect(ungroupLoses(d.elements, "foot")).toBe(false);
  });
});

describe("the preview pointer and a rig", () => {
  it("does not hand the rig's groups, its null or its footage to the pointer", () => {
    const d = riggedDoc({
      label: imageElement({ key: "label", trackId: "v1", startTime: 0, duration: 4000, parentId: "trk" } as any),
      plain: groupElement({ key: "plain", trackId: "gt", startTime: 9000 } as any),
    });
    for (const id of ["zoom", "cam", "trk", "foot"]) {
      expect(canPointerTarget(d.elements[id], 500, d.elements), id).toBe(false);
    }
    // A label riding the null, and an ordinary null, are still grabbable.
    expect(canPointerTarget(d.elements.label, 500, d.elements)).toBe(true);
    expect(canPointerTarget(d.elements.plain, 500, d.elements)).toBe(true);
  });
});
