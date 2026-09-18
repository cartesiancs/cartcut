import { describe, it, expect } from "vitest";
import {
  aspectOf,
  cropBegin,
  cropCapturesKey,
  cropChanged,
  cropDown,
  cropKey,
  cropMove,
  cropSetAspect,
  cropUp,
  cropZoneAt,
  CROP_KEY_CODES,
  type CropAction,
  type CropSession,
} from "./cropSession";
import { FULL_CROP } from "../timeline/cropOps";
import type { CropRect } from "../../@types/timeline";

const rect = (x: number, y: number, width: number, height: number): CropRect => ({
  x,
  y,
  width,
  height,
});

const FRAME = { width: 200, height: 100 };
const GRAB = { x: 0.05, y: 0.05 };

function session(over: Partial<CropSession> = {}): CropSession {
  return { ...cropBegin("el", FULL_CROP, FRAME), ...over };
}

/** The session an action carries, or a failure that says which kind arrived. */
function updated(action: CropAction): CropSession {
  expect(action.kind, `expected an update, got ${action.kind}`).toBe("update");
  return (action as { session: CropSession }).session;
}

describe("cropBegin", () => {
  it("opens on the crop the clip already has", () => {
    const s = cropBegin("el", rect(0.2, 0.1, 0.5, 0.6), FRAME);
    expect(s.rect).toEqual(rect(0.2, 0.1, 0.5, 0.6));
    expect(s.origin).toEqual(s.rect);
    expect(s.elementId).toBe("el");
    expect(s.drag).toBeNull();
    expect(s.hover).toBeNull();
  });

  it("starts free, so the first drag is unconstrained", () => {
    expect(aspectOf(cropBegin("el", FULL_CROP, FRAME)).id).toBe("free");
  });

  it("reports nothing to apply until something moves", () => {
    expect(cropChanged(cropBegin("el", FULL_CROP, FRAME))).toBe(false);
  });
});

// ------------------------------------------------------------------ the zones

describe("cropZoneAt", () => {
  const half = rect(0.25, 0.25, 0.5, 0.5);

  it.each([
    ["stretchNW", 0.25, 0.25],
    ["stretchNE", 0.75, 0.25],
    ["stretchSW", 0.25, 0.75],
    ["stretchSE", 0.75, 0.75],
    ["stretchN", 0.5, 0.25],
    ["stretchS", 0.5, 0.75],
    ["stretchW", 0.25, 0.5],
    ["stretchE", 0.75, 0.5],
  ])("finds %s at its own point", (zone, x, y) => {
    expect(cropZoneAt(half, { x, y }, GRAB)).toBe(zone);
  });

  it("prefers a corner to an edge where the two bands overlap", () => {
    expect(cropZoneAt(half, { x: 0.26, y: 0.26 }, GRAB)).toBe("stretchNW");
  });

  it("answers the body well inside the rectangle", () => {
    expect(cropZoneAt(half, { x: 0.5, y: 0.5 }, GRAB)).toBe("inside");
  });

  it("answers null outside it", () => {
    expect(cropZoneAt(half, { x: 0.05, y: 0.05 }, GRAB)).toBeNull();
    expect(cropZoneAt(half, { x: 0.95, y: 0.5 }, GRAB)).toBeNull();
  });

  it("keeps a body to grab on a rectangle smaller than the bands", () => {
    const tiny = rect(0.5, 0.5, 0.02, 0.02);
    expect(cropZoneAt(tiny, { x: 0.51, y: 0.51 }, GRAB)).toBe("inside");
  });

  it("answers null for a pointer that is not a point", () => {
    expect(cropZoneAt(half, { x: NaN, y: 0.5 }, GRAB)).toBeNull();
  });
});

// ------------------------------------------------------------------ the drags

describe("a drag", () => {
  it("arms on a grip and records where it started", () => {
    const s = updated(cropDown(session(), { x: 1, y: 1 }, GRAB));
    expect(s.drag?.zone).toBe("stretchSE");
    expect(s.drag?.from).toEqual({ x: 1, y: 1 });
    expect(s.drag?.rect).toEqual(FULL_CROP);
  });

  it("does nothing, and is still consumed, on a press outside the rectangle", () => {
    const small = session({ rect: rect(0.4, 0.4, 0.2, 0.2) });
    expect(cropDown(small, { x: 0.05, y: 0.05 }, GRAB).kind).toBe("none");
  });

  it("moves the rectangle while a grip is down", () => {
    let s = updated(cropDown(session(), { x: 1, y: 1 }, GRAB));
    s = updated(cropMove(s, { x: 0.6, y: 0.6 }));
    expect(s.rect.width).toBeCloseTo(0.6, 9);
    expect(s.rect.height).toBeCloseTo(0.6, 9);
    expect(s.rect.x).toBeCloseTo(0, 9);
  });

  it("recomputes from the mousedown rect, so a gesture cannot accumulate", () => {
    let s = updated(cropDown(session(), { x: 1, y: 1 }, GRAB));
    for (let i = 0; i < 6; i++) {
      s = updated(cropMove(s, { x: 0.6, y: 0.6 }));
    }
    expect(s.rect.width).toBeCloseTo(0.6, 9);
    expect(s.rect.height).toBeCloseTo(0.6, 9);
  });

  it("returns to where it started when the pointer comes back", () => {
    let s = updated(cropDown(session(), { x: 1, y: 1 }, GRAB));
    s = updated(cropMove(s, { x: 0.3, y: 0.3 }));
    s = updated(cropMove(s, { x: 1, y: 1 }));
    expect(s.rect.width).toBeCloseTo(1, 9);
    expect(s.rect.height).toBeCloseTo(1, 9);
  });

  it("records a hover with no button down, and nothing else", () => {
    const s = updated(cropMove(session(), { x: 0.4, y: 0.4 }));
    expect(s.hover).toEqual({ x: 0.4, y: 0.4 });
    expect(s.rect).toEqual(FULL_CROP);
  });

  it("costs no frame for a pointer that has not actually moved", () => {
    const s = updated(cropMove(session(), { x: 0.4, y: 0.4 }));
    expect(cropMove(s, { x: 0.4, y: 0.4 }).kind).toBe("none");
  });

  it("disarms on the button coming up, keeping the rectangle", () => {
    let s = updated(cropDown(session(), { x: 1, y: 1 }, GRAB));
    s = updated(cropMove(s, { x: 0.6, y: 0.6 }));
    const after = updated(cropUp(s));
    expect(after.drag).toBeNull();
    expect(after.rect).toEqual(s.rect);
  });

  it("ignores a button coming up when nothing was down", () => {
    expect(cropUp(session()).kind).toBe("none");
  });
});

// ----------------------------------------------------------------- the presets

describe("an aspect preset", () => {
  it("reshapes the rectangle around where it already is", () => {
    // The frame is 2:1, so a drawn 1:1 is a normalized 1:2 and the widest such
    // rect is half the frame's width.
    const s = updated(cropSetAspect(session(), "1:1"));
    expect(s.aspectId).toBe("1:1");
    expect(s.rect.width).toBeCloseTo(0.5, 9);
    expect(s.rect.height).toBeCloseTo(1, 9);
    expect(s.rect.x + s.rect.width / 2).toBeCloseTo(0.5, 9);
  });

  it("keeps the centre the user had already aimed, on the axis that has room", () => {
    // The frame is 2:1, so a drawn 1:1 is half the frame wide and the whole of
    // it tall. The horizontal centre is free to be kept; the vertical one has
    // nowhere to go and can only be the middle.
    const s = session({ rect: rect(0.6, 0.2, 0.3, 0.3) });
    const next = updated(cropSetAspect(s, "1:1"));
    expect(next.rect.x + next.rect.width / 2).toBeCloseTo(0.75, 9);
    expect(next.rect.y + next.rect.height / 2).toBeCloseTo(0.5, 9);
  });

  it("slides the reshaped rectangle back inside rather than letting it hang over", () => {
    const s = session({ rect: rect(0.9, 0.4, 0.1, 0.2) });
    const next = updated(cropSetAspect(s, "1:1"));
    expect(next.rect.x + next.rect.width).toBeCloseTo(1, 9);
    expect(next.rect.x).toBeGreaterThanOrEqual(0);
  });

  it("restores the whole frame for Original", () => {
    const s = session({ rect: rect(0.3, 0.3, 0.2, 0.2) });
    const next = updated(cropSetAspect(s, "original"));
    expect(next.rect).toEqual(FULL_CROP);
  });

  it("leaves the rectangle alone when the lock is released", () => {
    const shaped = updated(cropSetAspect(session(), "16:9"));
    const freed = updated(cropSetAspect(shaped, "free"));
    expect(freed.rect).toEqual(shaped.rect);
    expect(freed.aspectId).toBe("free");
  });

  it("does nothing for the preset already selected, or one that does not exist", () => {
    expect(cropSetAspect(session(), "free").kind).toBe("none");
    expect(cropSetAspect(session(), "nope").kind).toBe("none");
  });

  it("constrains the next drag once it is picked", () => {
    let s = updated(cropSetAspect(session(), "1:1"));
    s = updated(cropDown(s, { x: s.rect.x + s.rect.width, y: s.rect.y + s.rect.height }, GRAB));
    s = updated(cropMove(s, { x: 0.1, y: 0.1 }));
    const drawn = (s.rect.width * FRAME.width) / (s.rect.height * FRAME.height);
    expect(drawn).toBeCloseTo(1, 6);
  });
});

// -------------------------------------------------------------------- the keys

describe("the keys", () => {
  it("captures exactly the five it owns", () => {
    expect([...CROP_KEY_CODES].sort()).toEqual(
      ["Backspace", "Delete", "Enter", "Escape", "NumpadEnter"].sort(),
    );
    for (const code of CROP_KEY_CODES) {
      expect(cropCapturesKey(code), code).toBe(true);
    }
    for (const code of ["KeyA", "Space", "ArrowLeft", "KeyZ"]) {
      expect(cropCapturesKey(code), code).toBe(false);
    }
  });

  it("cancels on Escape, whatever state the session is in", () => {
    expect(cropKey(session(), "Escape").kind).toBe("cancel");
    expect(cropKey(session({ rect: rect(0, 0, 0.3, 0.3) }), "Escape").kind).toBe(
      "cancel",
    );
  });

  it("commits on Enter once the rectangle has moved", () => {
    const s = session({ rect: rect(0.1, 0.1, 0.5, 0.5) });
    for (const code of ["Enter", "NumpadEnter"]) {
      const action = cropKey(s, code);
      expect(action.kind, code).toBe("commit");
      expect((action as any).session.rect).toEqual(rect(0.1, 0.1, 0.5, 0.5));
      expect((action as any).session.drag).toBeNull();
    }
  });

  it("cancels rather than committing an unmoved rectangle", () => {
    expect(cropKey(session(), "Enter").kind).toBe("cancel");
  });

  it("resets to the whole frame on Backspace, rather than deleting the clip", () => {
    const s = session({ rect: rect(0.1, 0.1, 0.3, 0.3), aspectId: "16:9" });
    for (const code of ["Backspace", "Delete"]) {
      const next = updated(cropKey(s, code));
      expect(next.rect, code).toEqual(FULL_CROP);
      expect(next.aspectId).toBe("free");
    }
  });

  it("costs no frame for a Backspace on an already whole frame", () => {
    expect(cropKey(session(), "Backspace").kind).toBe("none");
  });

  it("ignores everything else", () => {
    for (const code of ["KeyA", "Space", "ArrowUp"]) {
      expect(cropKey(session(), code).kind, code).toBe("none");
    }
  });
});

describe("cropChanged", () => {
  it("is false for a rectangle put back where it started", () => {
    const s = session({ rect: rect(0, 0, 1, 1) });
    expect(cropChanged(s)).toBe(false);
  });

  it("is true once an edge has really moved", () => {
    expect(cropChanged(session({ rect: rect(0, 0, 0.9, 1) }))).toBe(true);
  });

  it("is false for a difference below the epsilon the op declines on", () => {
    expect(cropChanged(session({ rect: rect(0, 0, 1 - 1e-9, 1) }))).toBe(false);
  });
});
