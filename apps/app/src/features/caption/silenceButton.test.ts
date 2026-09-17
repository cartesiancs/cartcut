import { describe, expect, it } from "vitest";
import { silenceButtonState, type SilenceButtonInput } from "./silenceButton";

const input = (over: Partial<SilenceButtonInput> = {}): SilenceButtonInput => ({
  available: true,
  busy: false,
  gapCount: 3,
  silenceOn: true,
  lineCount: 5,
  ...over,
});

describe("silenceButtonState", () => {
  // The web build has no main process behind it, so the feature is absent
  // rather than unavailable, and a permanently dead control is worse than none.
  it("renders nothing at all without a bridge", () => {
    expect(silenceButtonState(input({ available: false }))).toBeNull();
  });

  it("spins, and declines, while the sweep runs", () => {
    const state = silenceButtonState(input({ busy: true }));
    expect(state?.busy).toBe(true);
    expect(state?.disabled).toBe(true);
    expect(state?.action).toBe("none");
  });

  it("declines before there is a transcript to intersect with", () => {
    const state = silenceButtonState(input({ lineCount: 0, gapCount: 0 }));
    expect(state?.disabled).toBe(true);
    expect(state?.action).toBe("none");
    expect(state?.label).toMatch(/transcribe/i);
  });

  // The sweep ran and found nothing. A user expecting their pauses to go needs
  // to be told that rather than left hunting for the button.
  it("says so when the sweep found nothing, rather than vanishing", () => {
    const state = silenceButtonState(input({ gapCount: 0 }));
    expect(state).not.toBeNull();
    expect(state?.disabled).toBe(true);
    expect(state?.label).toMatch(/no silent gaps/i);
  });

  it("offers to put the gaps back while they are cut", () => {
    const state = silenceButtonState(input({ silenceOn: true, gapCount: 3 }));
    expect(state?.action).toBe("off");
    expect(state?.variant).toBe("primary");
    expect(state?.label).toContain("3 silent gaps");
  });

  it("offers to take them out again once they are back", () => {
    const state = silenceButtonState(input({ silenceOn: false, gapCount: 3 }));
    expect(state?.action).toBe("on");
    expect(state?.variant).toBe("secondary");
  });

  it("counts one gap in the singular", () => {
    expect(silenceButtonState(input({ gapCount: 1 }))?.label).toContain(
      "1 silent gap back",
    );
    expect(
      silenceButtonState(input({ gapCount: 1, silenceOn: false }))?.label,
    ).toContain("1 silent gap again");
  });

  // For an icon-only button the tooltip is the only accessible name it has.
  it("never leaves the button nameless", () => {
    for (const busy of [true, false]) {
      for (const silenceOn of [true, false]) {
        for (const gapCount of [0, 1, 9]) {
          for (const lineCount of [0, 4]) {
            const state = silenceButtonState(
              input({ busy, silenceOn, gapCount, lineCount }),
            );
            expect(state?.label.length).toBeGreaterThan(0);
            expect(state?.icon.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("never offers a click that would decline", () => {
    for (const over of [
      { busy: true },
      { lineCount: 0 },
      { gapCount: 0 },
    ] as Partial<SilenceButtonInput>[]) {
      const state = silenceButtonState(input(over));
      expect(state?.disabled).toBe(true);
      expect(state?.action).toBe("none");
    }
  });
});

describe("silenceButtonState over several clips", () => {
  it("says the clips, plural, when none of them had a gap", () => {
    expect(
      silenceButtonState(input({ gapCount: 0, clipCount: 3 }))?.label,
    ).toBe("No silent gaps were found in these clips");
    expect(silenceButtonState(input({ gapCount: 0 }))?.label).toBe(
      "No silent gaps were found in this clip",
    );
  });
});
