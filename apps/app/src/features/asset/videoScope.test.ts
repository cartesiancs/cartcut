import { describe, expect, it } from "vitest";
import {
  activeVideoScope,
  createVideoScope,
  withVideoScope,
} from "./videoScope";

describe("createVideoScope", () => {
  it("gives every scope its own three collections", () => {
    const a = createVideoScope("a");
    const b = createVideoScope("b");

    expect(a.videos).not.toBe(b.videos);
    // Not shared, and that is what closes the `runAssetBatch` skip: a clip the
    // preview had started decoding made the export's load resolve without it.
    expect(a.loading).not.toBe(b.loading);
    expect(a.lastSeekRequests).not.toBe(b.lastSeekRequests);
    expect(a.id).toBe("a");
  });
});

describe("withVideoScope", () => {
  it("is null outside any extent", () => {
    expect(activeVideoScope()).toBeNull();
  });

  it("sets the scope for the duration and restores after", () => {
    const scope = createVideoScope("export:1");

    const seen = withVideoScope(scope, () => activeVideoScope());

    expect(seen).toBe(scope);
    expect(activeVideoScope()).toBeNull();
  });

  it("returns what draw returns", () => {
    expect(withVideoScope(createVideoScope("x"), () => 42)).toBe(42);
  });

  it("restores in order when nested", () => {
    const outer = createVideoScope("outer");
    const inner = createVideoScope("inner");
    const seen: (string | null)[] = [];

    withVideoScope(outer, () => {
      seen.push(activeVideoScope()?.id ?? null);
      withVideoScope(inner, () => {
        seen.push(activeVideoScope()?.id ?? null);
      });
      seen.push(activeVideoScope()?.id ?? null);
    });
    seen.push(activeVideoScope()?.id ?? null);

    expect(seen).toEqual(["outer", "inner", "outer", null]);
  });

  it("restores when draw throws", () => {
    // An aborted export throws out of the composite step. Leaving the scope
    // set would have the preview drawing handles that are about to be released.
    const scope = createVideoScope("export:2");

    expect(() =>
      withVideoScope(scope, () => {
        throw new Error("cancelled");
      }),
    ).toThrow("cancelled");

    expect(activeVideoScope()).toBeNull();
  });

  it("an explicit null extent hands lookups back to the shared set", () => {
    const scope = createVideoScope("export:3");

    withVideoScope(scope, () => {
      const inner = withVideoScope(null, () => activeVideoScope());
      expect(inner).toBeNull();
      expect(activeVideoScope()).toBe(scope);
    });
  });
});
