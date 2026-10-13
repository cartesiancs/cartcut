import { describe, expect, it } from "vitest";
import { audioElement, groupElement, imageElement } from "../renderer/testing";
import { adoptIntoRig, createGroup, dissolveRig, setParent, ungroup } from "./groupOps";
import {
  isRigMember,
  preRigElements,
  rigOf,
  rigRoleOf,
  withoutParent,
} from "./rig";
import { riggedDoc as rigged } from "./rigTesting";
import { applyPoint, worldMatrixOf } from "./transform";

describe("rigRoleOf", () => {
  it("reads only the two roles, and only on a group", () => {
    expect(rigRoleOf({ filetype: "group", rig: "stabilize-zoom" })).toBe("stabilize-zoom");
    expect(rigRoleOf({ filetype: "group", rig: "stabilize-camera" })).toBe("stabilize-camera");
    expect(rigRoleOf({ filetype: "group", rig: "other" })).toBeNull();
    expect(rigRoleOf({ filetype: "image", rig: "stabilize-zoom" })).toBeNull();
    expect(rigRoleOf({ filetype: "group" })).toBeNull();
    expect(rigRoleOf(null)).toBeNull();
  });
});

describe("rigOf", () => {
  it("finds the rig from the zoom, the camera and a camera child", () => {
    const d = rigged();
    const rig = { zoomId: "zoom", cameraId: "cam" };
    expect(rigOf(d.elements, "zoom")).toEqual(rig);
    expect(rigOf(d.elements, "cam")).toEqual(rig);
    expect(rigOf(d.elements, "foot")).toEqual(rig);
    expect(rigOf(d.elements, "trk")).toEqual(rig);
  });

  it("is null for anything that is not a whole rig", () => {
    const d = rigged({
      label: imageElement({ key: "label", trackId: "v1", startTime: 5000, parentId: "trk" } as any),
    });
    // Riding a null in the camera is not being held by the rig.
    expect(rigOf(d.elements, "label")).toBeNull();
    expect(rigOf(d.elements, "nope")).toBeNull();

    const without = (patch: Record<string, any>) =>
      ({ ...d.elements, ...patch }) as any;
    // Marker removed from either group.
    expect(rigOf(without({ cam: { ...d.elements.cam, rig: undefined } }), "foot")).toBeNull();
    expect(rigOf(without({ zoom: { ...d.elements.zoom, rig: undefined } }), "foot")).toBeNull();
    // The zoom off the root.
    expect(
      rigOf(
        without({ zoom: { ...d.elements.zoom, parentId: "box" }, box: groupElement({ trackId: "gz" } as any) }),
        "foot",
      ),
    ).toBeNull();
    // An orphan camera and an orphan zoom.
    expect(rigOf(without({ cam: withoutParent(d.elements.cam) }), "cam")).toBeNull();
    const { cam: _c, ...noCamera } = d.elements;
    expect(rigOf(noCamera as any, "zoom")).toBeNull();
    // Two cameras under one zoom.
    expect(
      rigOf(without({ cam2: { ...d.elements.cam, key: "cam2" } }), "foot"),
    ).toBeNull();
  });
});

describe("isRigMember", () => {
  it("is the two groups and what sits directly in the camera, nothing else", () => {
    const d = rigged({
      label: imageElement({ key: "label", trackId: "v1", startTime: 5000, parentId: "trk" } as any),
      loose: imageElement({ key: "loose", trackId: "v1", startTime: 9000 }),
    });
    expect(isRigMember(d.elements, "zoom")).toBe(true);
    expect(isRigMember(d.elements, "cam")).toBe(true);
    expect(isRigMember(d.elements, "foot")).toBe(true);
    expect(isRigMember(d.elements, "trk")).toBe(true);
    expect(isRigMember(d.elements, "label")).toBe(false);
    expect(isRigMember(d.elements, "loose")).toBe(false);
  });
});

describe("preRigElements", () => {
  it("measures a camera child without the camera, and nothing else changes", () => {
    const d = rigged();
    const before = preRigElements(d.elements, "foot");

    expect(before.foot.parentId).toBeUndefined();
    expect(before.cam).toBe(d.elements.cam);
    // The footage's world is its own local matrix: the space it was measured in.
    const m = worldMatrixOf(before, "foot", 500);
    const local = worldMatrixOf({ foot: withoutParent(d.elements.foot) } as any, "foot", 500);
    expect(m).toEqual(local);
    // And the live map puts the camera on top of it (negative control).
    expect(applyPoint(worldMatrixOf(d.elements, "foot", 500), { x: 0, y: 0 })).not.toEqual(
      applyPoint(m, { x: 0, y: 0 }),
    );
  });

  it("returns the map itself for a clip that is not in a camera", () => {
    const d = rigged({ loose: imageElement({ key: "loose", trackId: "v1", startTime: 9000 }) });
    expect(preRigElements(d.elements, "loose")).toBe(d.elements);
    expect(preRigElements(d.elements, "label")).toBe(d.elements);
  });
});

describe("dissolveRig", () => {
  const strip = ({ priority: _p, ...rest }: any) => rest;

  it("restores the camera's children exactly and removes both groups", () => {
    const d = rigged();
    const out = dissolveRig(d, { zoomId: "zoom", cameraId: "cam" });

    expect(out.elements.zoom).toBeUndefined();
    expect(out.elements.cam).toBeUndefined();
    expect(strip(out.elements.foot)).toEqual(strip(withoutParent(d.elements.foot)));
    expect(strip(out.elements.trk)).toEqual(strip(withoutParent(d.elements.trk)));
    // Rows are left as they are, as ungroup and delete leave them.
    expect(out.tracks.map((t) => t.id)).toEqual(d.tracks.map((t) => t.id));
  });

  it("keeps what rides a null, and ungroups anything else under the zoom", () => {
    const d = rigged({
      label: imageElement({ key: "label", trackId: "v1", startTime: 5000, parentId: "trk" } as any),
      extra: imageElement({ key: "extra", trackId: "v1", startTime: 9000, parentId: "zoom", location: { x: 5, y: 5 } } as any),
      inner: groupElement({ key: "inner", trackId: "gt", startTime: 9000, parentId: "cam" } as any),
    });
    const out = dissolveRig(d, { zoomId: "zoom", cameraId: "cam" });

    expect(out.elements.label.parentId).toBe("trk");
    expect(out.elements.inner.parentId).toBeUndefined();
    // Under a zoom of 1.2 about its pivot, ungroup keeps it where it looked.
    const looked = applyPoint(worldMatrixOf(d.elements, "extra", 9000), { x: 0, y: 0 });
    const now = applyPoint(worldMatrixOf(out.elements, "extra", 9000), { x: 0, y: 0 });
    expect(now.x).toBeCloseTo(looked.x, 9);
    expect(now.y).toBeCloseTo(looked.y, 9);
    expect(out.elements.extra.parentId).toBeUndefined();
  });

  it("is what ungroup does to either rig group", () => {
    const d = rigged();
    const rig = { zoomId: "zoom", cameraId: "cam" };
    expect(ungroup(d, "zoom", 700)).toEqual(dissolveRig(d, rig));
    expect(ungroup(d, "cam", 700)).toEqual(dissolveRig(d, rig));
  });
});

describe("adoptIntoRig", () => {
  const withLoose = () =>
    rigged({
      loose: imageElement({ key: "loose", trackId: "v1", startTime: 9000, location: { x: 1.1, y: 2.2 } }),
      sound: audioElement({ key: "sound", trackId: "a1" }),
      boxed: imageElement({ key: "boxed", trackId: "v1", startTime: 12000, parentId: "box" } as any),
      box: groupElement({ key: "box", trackId: "gt", startTime: 12000 } as any),
    });

  it("writes the parent and nothing else", () => {
    const d = withLoose();
    const out = adoptIntoRig(d, "cam", ["loose"]);
    const { parentId, priority: _p, ...rest } = out.elements.loose as any;
    const { priority: _q, ...was } = d.elements.loose as any;

    expect(parentId).toBe("cam");
    expect(rest).toEqual(was);
  });

  it("declines by identity", () => {
    const d = withLoose();
    expect(adoptIntoRig(d, "cam", ["nope"])).toBe(d);
    expect(adoptIntoRig(d, "cam", ["sound"])).toBe(d);
    expect(adoptIntoRig(d, "cam", ["boxed"])).toBe(d);
    expect(adoptIntoRig(d, "cam", ["zoom"])).toBe(d);
    expect(adoptIntoRig(d, "cam", [])).toBe(d);
    expect(adoptIntoRig(d, "cam", ["foot"])).toBe(d);
    expect(adoptIntoRig(d, "zoom", ["loose"])).toBe(d);
    expect(adoptIntoRig(d, "box", ["loose"])).toBe(d);
  });

  it("declines a subtree that would nest past the cap", () => {
    const chain: Record<string, any> = {
      top: groupElement({ key: "top", trackId: "gt", startTime: 20000 } as any),
    };
    let parent = "top";
    for (let i = 0; i < 7; i++) {
      chain[`c${i}`] = groupElement({ key: `c${i}`, trackId: "gt", startTime: 20000, parentId: parent } as any);
      parent = `c${i}`;
    }
    const d = rigged(chain);
    expect(adoptIntoRig(d, "cam", ["top"])).toBe(d);

    const { c6: _last, ...shorter } = chain;
    const ok = rigged(shorter);
    expect(adoptIntoRig(ok, "cam", ["top"])).not.toBe(ok);
  });
});

describe("the ordinary group ops leave a rig alone", () => {
  it("setParent declines into a rig, a rig group, and out of a camera", () => {
    const d = rigged({
      loose: imageElement({ key: "loose", trackId: "v1", startTime: 9000 }),
      box: groupElement({ key: "box", trackId: "gt", startTime: 9000 } as any),
    });
    expect(setParent(d, ["loose"], "cam", 0)).toBe(d);
    expect(setParent(d, ["loose"], "zoom", 0)).toBe(d);
    expect(setParent(d, ["zoom"], "box", 0)).toBe(d);
    expect(setParent(d, ["cam"], null, 0)).toBe(d);
    expect(setParent(d, ["foot"], null, 0)).toBe(d);
    expect(setParent(d, ["trk"], "box", 0)).toBe(d);
    // And still works for what the rig does not hold.
    expect(setParent(d, ["loose"], "box", 0)).not.toBe(d);
  });

  it("createGroup declines a rig member", () => {
    const d = rigged({ loose: imageElement({ key: "loose", trackId: "v1", startTime: 9000 }) });
    expect(createGroup(d, ["zoom"], "g", "gt")).toBe(d);
    expect(createGroup(d, ["foot"], "g", "gt")).toBe(d);
    expect(createGroup(d, ["loose", "trk"], "g", "gt")).toBe(d);
    expect(createGroup(d, ["loose"], "g", "gt")).not.toBe(d);
  });
});
