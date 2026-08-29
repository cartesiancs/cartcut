/**
 * Style profiles: the numbers an edit is made of, as data.
 *
 * Cartcut is a general-purpose editor, so no single taste may be compiled in.
 * Every number a grammar needs — how much air to leave around a cut, how often
 * to push in, whether to reach for a transition at all, how long a caption line
 * is — lives in a profile on disk. Several ship; a user drops their own beside
 * them and the agent uses it.
 *
 * ## Why these are not `assets/presets/`
 *
 * The plan was to reuse the fx preset scanner and its user directory. That is
 * wrong for a reason worth writing down: `features/fx/presetValidate.ts` checks
 * `kind: must be `effect` or `transition`` and **fails a manifest with anything
 * else**, so a style profile sitting in that tree would appear in the user's
 * preset browser as a broken preset. Styles get their own root, with the same
 * builtin-then-user shape and the same first-wins rule.
 *
 * ## Choosing one
 *
 * `chooseStyle` scores each profile's declared `fit` against what the material
 * actually is — the aspect ratio, how fast the speech runs, whether there is
 * music. The choice is data-driven for the same reason the numbers are: a
 * user's own profile has to be able to say when it applies. And it comes back
 * with its reasons, because an agent that says "punchy, because this is
 * vertical and the speech is fast" can be corrected in one sentence, and one
 * that just says "punchy" cannot.
 */

export type StyleFit = {
  /** `null` or absent means "does not care". */
  aspect?: "vertical" | "horizontal" | "square" | null;
  musicLed?: boolean | null;
  /** Words per minute the profile is written for. */
  speechRate?: { min?: number; max?: number } | null;
};

export type StyleProfile = {
  id: string;
  name: string;
  description: string;
  fit?: StyleFit;

  cutting: {
    /** Air left either side of a word boundary, so consonants are not clipped. */
    paddingMs: number;
    /** Shortest a shot may be, whatever the words suggest. */
    minShotMs: number;
    /** A silence longer than this is trimmed *to* this, not to nothing. */
    maxSilenceMs: number;
    removeFillers: boolean;
  };

  motion: {
    /** How often to push in. 0 means never. */
    punchesPerMinute: number;
    /** Scale in tenths, the units the track stores. */
    punchScale: number;
    easing: string;
    /** Prefer moments the audio marks as loud, rather than even spacing. */
    onEmphasis: boolean;
  };

  transitions: {
    /** Preset ids this style will reach for. Empty means cuts only. */
    allowed: string[];
    perMinute: number;
    durationMs: number;
  };

  captions: {
    /** Words per line. Two is the short-form look; five or six reads as prose. */
    wordsPerLine: number;
    case: "as-spoken" | "upper";
    /** Vertical position as a percentage of frame height. */
    positionPercent: number;
  };

  effects: {
    /** Preset ids this style will reach for. Empty means none. */
    allowed: string[];
  };
};

/** What the material is, as far as choosing a style goes. */
export type Material = {
  aspect: "vertical" | "horizontal" | "square";
  /** Words per minute, or null when there is no speech to measure. */
  speechRatePerMin: number | null;
  musicLed: boolean;
};

/** The aspect of a frame, by the only distinction that changes an edit. */
export function aspectOf(width: number, height: number): Material["aspect"] {
  if (!(width > 0) || !(height > 0)) {
    return "horizontal";
  }
  const ratio = width / height;
  if (ratio < 0.95) {
    return "vertical";
  }
  if (ratio > 1.05) {
    return "horizontal";
  }
  return "square";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A profile, or a list of what is wrong with it.
 *
 * Validated rather than trusted because a profile is a file a user wrote, and
 * the failure mode of a missing number is an edit made with `undefined` as a
 * duration. Reporting which field is wrong is what makes a hand-written profile
 * fixable.
 */
export function validateStyle(raw: unknown): {
  ok: boolean;
  profile?: StyleProfile;
  errors: string[];
} {
  const errors: string[] = [];
  const value = raw as any;

  if (value == null || typeof value !== "object") {
    return { ok: false, errors: ["not an object"] };
  }

  for (const field of ["id", "name", "description"]) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      errors.push(`${field}: must be a non-empty string`);
    }
  }

  const numbers: Array<[string, unknown]> = [
    ["cutting.paddingMs", value.cutting?.paddingMs],
    ["cutting.minShotMs", value.cutting?.minShotMs],
    ["cutting.maxSilenceMs", value.cutting?.maxSilenceMs],
    ["motion.punchesPerMinute", value.motion?.punchesPerMinute],
    ["motion.punchScale", value.motion?.punchScale],
    ["transitions.perMinute", value.transitions?.perMinute],
    ["transitions.durationMs", value.transitions?.durationMs],
    ["captions.wordsPerLine", value.captions?.wordsPerLine],
    ["captions.positionPercent", value.captions?.positionPercent],
  ];
  for (const [field, entry] of numbers) {
    if (!isNumber(entry)) {
      errors.push(`${field}: must be a number`);
    }
  }

  if (typeof value.cutting?.removeFillers !== "boolean") {
    errors.push("cutting.removeFillers: must be a boolean");
  }
  if (typeof value.motion?.onEmphasis !== "boolean") {
    errors.push("motion.onEmphasis: must be a boolean");
  }
  if (typeof value.motion?.easing !== "string") {
    errors.push("motion.easing: must be a string");
  }
  if (!Array.isArray(value.transitions?.allowed)) {
    errors.push("transitions.allowed: must be an array of preset ids");
  }
  if (!Array.isArray(value.effects?.allowed)) {
    errors.push("effects.allowed: must be an array of preset ids");
  }
  if (
    value.captions?.case !== "as-spoken" &&
    value.captions?.case !== "upper"
  ) {
    errors.push('captions.case: must be "as-spoken" or "upper"');
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, profile: value as StyleProfile, errors: [] };
}

/** How well one profile suits the material, and why. */
export type StyleScore = {
  profile: StyleProfile;
  score: number;
  reasons: string[];
};

/**
 * What each signal is worth.
 *
 * They are not equally informative and scoring them equally produced a wrong
 * answer on the first real project: a music-backed horizontal video, where
 * "there is a music bed" and "the video is horizontal" both scored one and the
 * tie fell to whichever file the directory listed first. It picked the
 * documentary profile for a music video.
 *
 *  - **Music is a statement of intent.** A project with a bed under it is being
 *    cut to music, and that decides the pace more than anything else does.
 *  - **Speech rate is what the profiles mostly differ on** — it is the closest
 *    thing to a measurement of the pace the material wants.
 *  - **Aspect is weak evidence.** Nearly everything is horizontal, so matching
 *    it says little; it is worth something only as a tie-break, which is
 *    exactly what one point makes it.
 */
const WEIGHTS = { musicLed: 2, speechRate: 2, aspect: 1 } as const;

/**
 * Score every profile against the material.
 *
 * A criterion a profile does not declare is not a match and not a miss — it
 * simply says nothing, which is how a general-purpose profile stays eligible
 * everywhere. A criterion it declares and misses is disqualifying: a profile
 * written for vertical video is not the one to use on a widescreen documentary
 * merely because nothing better scored.
 */
export function scoreStyles(
  profiles: StyleProfile[],
  material: Material,
): StyleScore[] {
  return profiles
    .map((profile) => {
      const fit = profile.fit ?? {};
      const reasons: string[] = [];
      let score = 0;
      let disqualified = false;

      if (fit.aspect != null) {
        if (fit.aspect === material.aspect) {
          score += WEIGHTS.aspect;
          reasons.push(`the video is ${material.aspect}`);
        } else {
          disqualified = true;
        }
      }

      if (fit.musicLed != null) {
        if (fit.musicLed === material.musicLed) {
          score += WEIGHTS.musicLed;
          reasons.push(
            material.musicLed
              ? "there is a music bed"
              : "there is no music bed",
          );
        } else {
          disqualified = true;
        }
      }

      if (fit.speechRate != null && material.speechRatePerMin != null) {
        const { min, max } = fit.speechRate;
        const rate = material.speechRatePerMin;
        if ((min == null || rate >= min) && (max == null || rate <= max)) {
          score += WEIGHTS.speechRate;
          reasons.push(`the speech runs at ${Math.round(rate)} words a minute`);
        } else {
          disqualified = true;
        }
      }

      return {
        profile,
        score: disqualified ? -1 : score,
        reasons: disqualified ? [] : reasons,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The profile to start from, with the reasons for it.
 *
 * Ties go to whichever came first, and profiles are loaded builtin-then-user —
 * so a user profile ties with a shipped one rather than beating it. That is
 * deliberate: a user who wants their own to win says so by giving it a `fit`
 * the material actually matches, which is a decision rather than an accident of
 * load order.
 */
export function chooseStyle(
  profiles: StyleProfile[],
  material: Material,
  preferId?: string,
): { profile: StyleProfile | null; why: string } {
  if (preferId != null) {
    const named = profiles.find((p) => p.id === preferId);
    if (named != null) {
      return { profile: named, why: "you asked for it by name" };
    }
  }

  const scored = scoreStyles(profiles, material).filter((s) => s.score >= 0);
  const best = scored[0];
  if (best == null) {
    return { profile: null, why: "no style profile suits this material" };
  }

  if (best.reasons.length === 0) {
    return {
      profile: best.profile,
      why: "nothing about the material pointed anywhere in particular",
    };
  }
  return { profile: best.profile, why: best.reasons.join(", and ") };
}
