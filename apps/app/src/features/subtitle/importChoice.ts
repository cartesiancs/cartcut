/**
 * The one question an import has to ask, and its two answers.
 *
 * A subtitle file states times without saying what they are times *into*. Two
 * answers cover everything that turns up: the finished timeline (a file this app
 * exported, or one authored against a rendered cut) and one clip's source file
 * (a file a transcription service produced from the raw footage). Nothing can
 * tell them apart by inspection, so the user is asked.
 *
 * The decisions live here rather than in the dialog component for the reason
 * `menus.ts` and `silenceButton.ts` both give about themselves: there is no DOM
 * test environment in this repo, so a rule written inside a Lit class is a rule
 * nothing can check.
 *
 * **Always two options, disabled rather than absent.** A list whose entries
 * appear and disappear depending on the selection is a list nobody can aim at,
 * and the missing Clip row would silently shift Cancel up under the pointer. It
 * is also the only way the user learns that selecting a clip first is what
 * unlocks it.
 */

export type SubtitleTimeBase =
  | { kind: "timeline" }
  | { kind: "clip"; key: string };

export type TimeBaseOption = {
  base: SubtitleTimeBase;
  /** A material-symbols ligature. */
  icon: string;
  /** One word. The icons carry the rest. */
  label: string;
  /** The fact the word cannot carry, or empty. Never a sentence. */
  detail: string;
  disabled: boolean;
  selected: boolean;
};

/** What a dialog shows before anything is chosen. Timeline, always. */
export const DEFAULT_TIME_BASE: SubtitleTimeBase = { kind: "timeline" };

export type TimeBaseInput = {
  /**
   * The one clip the cues could be timed against, or null.
   *
   * Null covers both "nothing is selected" and "what is selected is not a clip
   * with a source window", and the option reads the same either way: there is
   * nothing to time against.
   */
  selectedClip: { key: string; name: string } | null;
  current: SubtitleTimeBase;
};

export function timeBaseOptions(input: TimeBaseInput): TimeBaseOption[] {
  const clip = input.selectedClip;
  // A `clip` base whose key is no longer the selected one cannot be honoured, so
  // the Timeline row shows as chosen. Otherwise a stale selection would leave
  // the dialog with nothing selected and an Import button that did something
  // the user was not shown.
  const onClip =
    input.current.kind === "clip" &&
    clip != null &&
    input.current.key === clip.key;

  return [
    {
      base: { kind: "timeline" },
      icon: "schedule",
      label: "Timeline",
      detail: "",
      disabled: false,
      selected: !onClip,
    },
    {
      base: clip == null ? { kind: "timeline" } : { kind: "clip", key: clip.key },
      icon: "movie",
      label: "Clip",
      detail: clip?.name ?? "",
      disabled: clip == null,
      selected: onClip,
    },
  ];
}

/**
 * The base to import with, given what the user picked and what is selected now.
 *
 * The dialog holds a `SubtitleTimeBase` and so could hand one straight to the
 * importer, except that the selection can change while the dialog is open. This
 * is the same clamp `timeBaseOptions` applies to `selected`, so what runs is
 * always what was shown.
 */
export function resolveTimeBase(input: TimeBaseInput): SubtitleTimeBase {
  const chosen = timeBaseOptions(input).find((option) => option.selected);
  return chosen?.base ?? DEFAULT_TIME_BASE;
}
