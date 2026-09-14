/**
 * What the silence button says, when all it has is an icon.
 *
 * It was two labelled buttons in the panel's left column, "remove silence" and
 * "clear". It is one icon in the footer now, beside Apply, which means the
 * words that carried the meaning are gone and the state has to be readable from
 * the glyph, the colour and the tooltip alone.
 *
 * That is exactly the kind of rule that disappears into a Lit template and
 * stops being checkable: `apps/automatic-caption/` is outside every vitest
 * include pattern, so a four-state button written there is a four-state button
 * nothing can assert about. It is here for the same reason `lines.ts`,
 * `editor.ts` and `layout.ts` are.
 *
 * ## It no longer starts the sweep
 *
 * It used to. The gaps were found when the button was pressed and staged until
 * Apply, so the button meant "go and look" the first time and "put them back"
 * afterwards. The session sweeps as soon as the transcript lands now and the
 * cuts are already on the timeline by the time anyone sees this, so the button
 * has exactly one job: turn them off, and turn them on again.
 *
 * Which makes it a real toggle rather than a control that changed meaning under
 * the user, and it is the reason `action` names a destination (`"on"`, `"off"`)
 * rather than a verb.
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
  /** What a click asks for. `"none"` is a button that would decline. */
  action: "on" | "off" | "none";
  /** Whether the glyph should spin. */
  busy: boolean;
};

export type SilenceButtonInput = {
  /** Whether the analyze bridge exists. False in the web build. */
  available: boolean;
  /** The sweep is running. */
  busy: boolean;
  /** How many silent gaps were found. Zero means the sweep found none. */
  gapCount: number;
  /** Whether those gaps are currently cut out of the timeline. */
  silenceOn: boolean;
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
export function silenceButtonState(
  input: SilenceButtonInput,
): SilenceButtonState | null {
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

  if (input.gapCount === 0) {
    // A real answer rather than a missing control: the sweep ran and found
    // nothing, and a user who expected their pauses to go needs to be told that
    // rather than left looking for the button.
    return {
      icon: SILENCE_ICON,
      variant: "secondary",
      disabled: true,
      label: "No silent gaps were found in this clip",
      action: "none",
      busy: false,
    };
  }

  if (input.silenceOn) {
    return {
      icon: SILENCE_ICON,
      variant: "primary",
      disabled: false,
      label: `Put the ${input.gapCount} silent gap${input.gapCount === 1 ? "" : "s"} back`,
      action: "off",
      busy: false,
    };
  }

  return {
    icon: SILENCE_ICON,
    variant: "secondary",
    disabled: false,
    label: `Remove the ${input.gapCount} silent gap${input.gapCount === 1 ? "" : "s"} again`,
    action: "on",
    busy: false,
  };
}
