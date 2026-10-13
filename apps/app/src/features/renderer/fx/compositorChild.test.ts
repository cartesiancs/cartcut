import { describe, expect, it, vi } from "vitest";
import { FxCompositor } from "./compositor";

/**
 * The child a template's own composite runs through: its own buffers, the
 * parent's preset caches, one level only, and released without taking the
 * parent's caches with it. Against a WebGL stand-in that answers every call:
 * nothing here draws, it only has to construct and dispose.
 */

function fakeGl(): WebGLRenderingContext {
  const made = () => ({});
  return new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (key in target) {
        return target[key as string];
      }
      if (typeof key === "string" && key.startsWith("create")) {
        return made;
      }
      if (key === "canvas") {
        return { width: 0, height: 0 };
      }
      return () => undefined;
    },
  }) as unknown as WebGLRenderingContext;
}

const internals = (c: FxCompositor) => c as unknown as Record<string, any>;

describe("FxCompositor#child", () => {
  it("is one compositor per parent, and none for a child", () => {
    const parent = new FxCompositor(fakeGl());
    const child = parent.child();
    expect(child).not.toBeNull();
    expect(parent.child()).toBe(child);
    expect(child!.child()).toBeNull();
  });

  it("shares the preset caches and keeps its own buffers", () => {
    const parent = new FxCompositor(fakeGl());
    const child = parent.child()!;
    for (const shared of ["programs", "inlinePrograms", "textures", "lutTextures", "reported"]) {
      expect(internals(child)[shared]).toBe(internals(parent)[shared]);
    }
    for (const own of ["fromTarget", "toTarget", "outputTarget", "passA", "passB"]) {
      expect(internals(child)[own]).not.toBe(internals(parent)[own]);
    }
  });

  it("leaves the shared caches alone when it is released, and the parent does not", () => {
    const parent = new FxCompositor(fakeGl());
    const child = parent.child()!;
    const program = { dispose: vi.fn() };
    internals(parent).programs.set("p", program);

    child.dispose();
    expect(program.dispose).not.toHaveBeenCalled();
    expect(internals(parent).programs.size).toBe(1);

    parent.dispose();
    expect(program.dispose).toHaveBeenCalledTimes(1);
    expect(internals(parent).programs.size).toBe(0);
  });

  it("is released with its parent", () => {
    const parent = new FxCompositor(fakeGl());
    const child = parent.child()!;
    const own = vi.spyOn(internals(child).passA, "dispose");
    parent.dispose();
    expect(own).toHaveBeenCalled();
    // And a parent used again after a release makes a fresh child.
    expect(parent.child()).not.toBe(child);
  });
});
