/**
 * What the silence button says, when all it has is an icon.
 *
 * The sweep used to be two labelled buttons in the panel's left column,
 * "remove silence" and "clear". They are one icon in the footer now, beside
 * Apply, which means the words that carried the meaning are gone and the state
 * has to be readable from the glyph, the colour and the tooltip alone.
 *
 * That is exactly the kind of rule that disappears into a Lit template and
 * stops being checkable: `apps/automatic-caption/` is outside every vitest
 * include pattern, so a three-state button written there is a three-state
 * button nothing can assert about. It is here for the same reason `lines.ts`,
 * `editor.ts` and `layout.ts` are.
 *
 * The button is a **toggle**, not a one-shot. Pressing it with a sweep already
 * staged puts the gaps back, because the alternative is a second icon that
 * exists only some of the time and shifts Apply sideways when it appears.
 */

/** The glyph for every state but the spinner. One icon, so it names the thing. */
const SILENCE_ICON = "volume_off";

/** The spinner, which is the one state that is about the app and not the edit. */
const BUSY_ICON = "progress_activity";

export type SilenceButtonState = {
  /** A material-symbols ligature. */
  icon: string;
  /** The Bootstrap variant, so the button reads `btn btn-sm btn-<variant>`. */
  variant: "primary" | "secondary";
  disabled: boolean;
  /**
   * The tooltip and the accessible name, which for an icon-only button are the
   * only name it has. Never empty.
   */
  label: string;
  /** What a click means right now. */
  action: "find" | "clear" | "none";
  /** Whether the glyph should spin. */
  busy: boolean;
};

export type SilenceButtonInput = {
  /** Whether the analyze bridge exists. False in the web build. */
  available: boolean;
  /** A decode is running. */
  busy: boolean;
  /** How many silent ranges are staged. */
  cutCount: number;
  /** How many caption lines there are. Zero means nothing has been transcribed. */
  lineCount: number;
};

/**
 * The button, or `null` for "do not render one at all".
 *
 * Null rather than a disabled button when there is no bridge behind it: the web
 * build has no main process, so the feature is absent rather than unavailable,
 * and a permanently dead control in the footer is worse than no control. That
 * is the same call `_transcribeApi` and `_analyzeApi` already make.
 */
export function silenceButtonState(input: SilenceButtonInput): SilenceButtonState | null {
  if (!input.available) {
    return null;
  }

  if (input.busy) {
    return {
      icon: BUSY_ICON,
      variant: "secondary",
      disabled: true,
      label: "Finding the silent gaps",
      action: "none",
      busy: true,
    };
  }

  if (input.lineCount === 0) {
    // The sweep is an intersection of the signal and the *words*, so with no
    // transcript there is nothing to intersect and it would find nothing. Said
    // in the tooltip rather than by the button simply doing nothing.
    return {
      icon: SILENCE_ICON,
      variant: "secondary",
      disabled: true,
      label: "Transcribe the clip first, then silent gaps can be found",
      action: "none",
      busy: false,
    };
  }

  if (input.cutCount > 0) {
    return {
      icon: SILENCE_ICON,
      variant: "primary",
      disabled: false,
      label: `Put the ${input.cutCount} silent gap${input.cutCount === 1 ? "" : "s"} back`,
      action: "clear",
      busy: false,
    };
  }

  return {
    icon: SILENCE_ICON,
    variant: "secondary",
    disabled: false,
    label: "Remove the silent gaps",
    action: "find",
    busy: false,
  };
}
