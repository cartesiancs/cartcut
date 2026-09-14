import { describe, expect, it } from "vitest";

import { silenceButtonState, type SilenceButtonInput } from "./silenceButton";

const input = (overrides: Partial<SilenceButtonInput> = {}): SilenceButtonInput => ({
  available: true,
  busy: false,
  cutCount: 0,
  lineCount: 8,
  ...overrides,
});

describe("silenceButtonState", () => {
  it("renders nothing at all without a bridge behind it", () => {
    expect(silenceButtonState(input({ available: false }))).toBeNull();
    // Even with everything else ready to go.
    expect(silenceButtonState(input({ available: false, cutCount: 3 }))).toBeNull();
  });

  it("offers the sweep once there is a transcript", () => {
    expect(silenceButtonState(input())).toMatchObject({
      variant: "secondary",
      disabled: false,
      action: "find",
      busy: false,
    });
  });

  it("spins and refuses a second click while a decode is running", () => {
    const state = silenceButtonState(input({ busy: true }))!;
    expect(state.busy).toBe(true);
    expect(state.disabled).toBe(true);
    expect(state.action).toBe("none");
  });

  it("stays busy even when a previous sweep is staged", () => {
    expect(silenceButtonState(input({ busy: true, cutCount: 4 }))!.action).toBe("none");
  });

  it("is disabled with nothing transcribed, because the sweep is an intersection", () => {
    const state = silenceButtonState(input({ lineCount: 0 }))!;
    expect(state.disabled).toBe(true);
    expect(state.action).toBe("none");
  });

  it("turns into a way back once gaps are staged", () => {
    const state = silenceButtonState(input({ cutCount: 5 }))!;
    expect(state.variant).toBe("primary");
    expect(state.action).toBe("clear");
    expect(state.label).toContain("5");
  });

  it("counts one gap in the singular", () => {
    expect(silenceButtonState(input({ cutCount: 1 }))!.label).toBe(
      "Put the 1 silent gap back",
    );
    expect(silenceButtonState(input({ cutCount: 2 }))!.label).toBe(
      "Put the 2 silent gaps back",
    );
  });

  it("always carries a name, because the glyph is the only other thing there is", () => {
    const cases: SilenceButtonInput[] = [
      input(),
      input({ busy: true }),
      input({ lineCount: 0 }),
      input({ cutCount: 3 }),
    ];
    for (const each of cases) {
      const state = silenceButtonState(each)!;
      expect(state.label.length).toBeGreaterThan(0);
      expect(state.icon.length).toBeGreaterThan(0);
    }
  });

  it("uses one glyph for every state that is about the edit", () => {
    const icons = new Set(
      [input(), input({ lineCount: 0 }), input({ cutCount: 3 })].map(
        (each) => silenceButtonState(each)!.icon,
      ),
    );
    expect(icons.size).toBe(1);
    // The spinner is the exception, and it is about the app rather than the cut.
    expect(silenceButtonState(input({ busy: true }))!.icon).not.toBe([...icons][0]);
  });
});
