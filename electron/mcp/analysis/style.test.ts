import { describe, it, expect } from "vitest";
import {
  aspectOf,
  chooseStyle,
  scoreStyles,
  validateStyle,
  type StyleProfile,
} from "./style";

function profile(over: Partial<StyleProfile> = {}): StyleProfile {
  return {
    id: "test",
    name: "Test",
    description: "A profile for tests.",
    cutting: {
      paddingMs: 100,
      minShotMs: 800,
      maxSilenceMs: 400,
      removeFillers: true,
    },
    motion: {
      punchesPerMinute: 4,
      punchScale: 11.5,
      easing: "snap",
      onEmphasis: true,
    },
    transitions: { allowed: [], perMinute: 0, durationMs: 400 },
    captions: { wordsPerLine: 4, case: "as-spoken", positionPercent: 80 },
    effects: { allowed: [] },
    ...over,
  };
}

describe("aspectOf", () => {
  it("calls a phone video vertical", () => {
    expect(aspectOf(1080, 1920)).toBe("vertical");
  });

  it("calls a widescreen video horizontal", () => {
    expect(aspectOf(1920, 1080)).toBe("horizontal");
  });

  it("calls a square video square", () => {
    expect(aspectOf(1080, 1080)).toBe("square");
  });

  it("does not call a slightly-off square vertical", () => {
    expect(aspectOf(1080, 1100)).toBe("square");
  });

  it("falls back rather than dividing by zero", () => {
    expect(aspectOf(0, 0)).toBe("horizontal");
  });
});

describe("validateStyle", () => {
  it("accepts a complete profile", () => {
    const result = validateStyle(profile());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("names the field that is missing rather than just failing", () => {
    // A profile is a file a user wrote; the failure mode of a missing number is
    // an edit made with `undefined` as a duration.
    const broken: any = profile();
    delete broken.cutting.minShotMs;

    const result = validateStyle(broken);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("cutting.minShotMs: must be a number");
  });

  it("rejects a caption case it does not know", () => {
    const result = validateStyle(
      profile({ captions: { wordsPerLine: 2, case: "Title" as any, positionPercent: 80 } }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/captions.case/);
  });

  it("rejects anything that is not an object", () => {
    expect(validateStyle(null).ok).toBe(false);
    expect(validateStyle("punchy").ok).toBe(false);
  });

  it("collects every error rather than stopping at the first", () => {
    const result = validateStyle({ id: "x" });
    expect(result.errors.length).toBeGreaterThan(5);
  });
});

describe("scoreStyles", () => {
  const material = {
    aspect: "vertical" as const,
    speechRatePerMin: 180,
    musicLed: false,
  };

  it("scores a profile that declares nothing as eligible everywhere", () => {
    const [scored] = scoreStyles([profile()], material);
    expect(scored.score).toBe(0);
    expect(scored.reasons).toEqual([]);
  });

  it("rewards each criterion the material matches", () => {
    const [scored] = scoreStyles(
      [profile({ fit: { aspect: "vertical", musicLed: false } })],
      material,
    );
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.reasons).toHaveLength(2);
  });

  it("weighs a music bed above an aspect ratio", () => {
    // Found on the first real project: a music-backed horizontal video where
    // both criteria scored one, the tie fell to directory order, and it picked
    // the documentary profile for a music video. Nearly everything is
    // horizontal, so matching that says very little.
    const musicMaterial = {
      aspect: "horizontal" as const,
      speechRatePerMin: null,
      musicLed: true,
    };

    const byMusic = scoreStyles(
      [profile({ id: "music", fit: { musicLed: true } })],
      musicMaterial,
    )[0];
    const byAspect = scoreStyles(
      [profile({ id: "doc", fit: { aspect: "horizontal" } })],
      musicMaterial,
    )[0];

    expect(byMusic.score).toBeGreaterThan(byAspect.score);
  });

  it("weighs speech rate above an aspect ratio too", () => {
    const byRate = scoreStyles(
      [profile({ fit: { speechRate: { min: 150 } } })],
      material,
    )[0];
    const byAspect = scoreStyles(
      [profile({ fit: { aspect: "vertical" } })],
      material,
    )[0];

    expect(byRate.score).toBeGreaterThan(byAspect.score);
  });

  it("disqualifies a profile whose declared criterion misses", () => {
    // A profile written for vertical video is not the one to use on a
    // widescreen documentary merely because nothing else scored.
    const [scored] = scoreStyles(
      [profile({ fit: { aspect: "horizontal" } })],
      material,
    );
    expect(scored.score).toBe(-1);
  });

  it("ignores a speech-rate criterion when there is no speech", () => {
    const [scored] = scoreStyles(
      [profile({ fit: { speechRate: { min: 200 } } })],
      { ...material, speechRatePerMin: null },
    );
    // Says nothing rather than missing.
    expect(scored.score).toBe(0);
  });

  it("matches a speech rate inside the declared band", () => {
    const [scored] = scoreStyles(
      [profile({ fit: { speechRate: { min: 150, max: 220 } } })],
      material,
    );
    expect(scored.score).toBeGreaterThan(0);
    expect(scored.reasons).toHaveLength(1);
  });

  it("disqualifies a speech rate outside it", () => {
    const [scored] = scoreStyles(
      [profile({ fit: { speechRate: { max: 120 } } })],
      material,
    );
    expect(scored.score).toBe(-1);
  });
});

describe("chooseStyle", () => {
  const material = {
    aspect: "vertical" as const,
    speechRatePerMin: 190,
    musicLed: false,
  };

  it("picks the most specific match and says why", () => {
    const general = profile({ id: "general" });
    const specific = profile({
      id: "punchy",
      fit: { aspect: "vertical", speechRate: { min: 150 } },
    });

    const chosen = chooseStyle([general, specific], material);
    expect(chosen.profile?.id).toBe("punchy");
    expect(chosen.why).toMatch(/vertical/);
    expect(chosen.why).toMatch(/words a minute/);
  });

  it("says plainly when nothing pointed anywhere", () => {
    const chosen = chooseStyle([profile({ id: "general" })], material);
    expect(chosen.profile?.id).toBe("general");
    expect(chosen.why).toMatch(/nothing about the material/);
  });

  it("honours a name over the fit, and says so", () => {
    const chosen = chooseStyle(
      [profile({ id: "a" }), profile({ id: "b" })],
      material,
      "b",
    );
    expect(chosen.profile?.id).toBe("b");
    expect(chosen.why).toMatch(/by name/);
  });

  it("falls back to fitting when the named profile does not exist", () => {
    const chosen = chooseStyle([profile({ id: "a" })], material, "nope");
    expect(chosen.profile?.id).toBe("a");
  });

  it("returns nothing when every profile is disqualified", () => {
    const chosen = chooseStyle(
      [profile({ fit: { aspect: "horizontal" } })],
      material,
    );
    expect(chosen.profile).toBeNull();
  });

  it("lets a shipped profile keep a tie against a user one", () => {
    // Load order is builtin-then-user. A user profile that wants to win says so
    // with a `fit` the material matches, which is a decision rather than an
    // accident of ordering.
    const builtin = profile({ id: "builtin" });
    const user = profile({ id: "user" });
    expect(chooseStyle([builtin, user], material).profile?.id).toBe("builtin");
  });
});
