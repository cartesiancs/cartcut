/**
 * The seven things a first-run user is walked through, after the tour.
 *
 * Unlike the tour's cards, every step here points at a real control and waits
 * for the user to use it: `completion` says what counts, and `runner.ts`
 * advances by itself once it has happened. Next is always there as well, so a
 * step nobody wants to do is one click, not a dead end.
 *
 * Kept free of DOM and of Lit, like `onboarding/steps.ts`, so the table can be
 * checked in the node suite.
 */

export type Side = "top" | "right" | "bottom" | "left";

/**
 * Everything a step can point at. `TARGET_SELECTORS` says how each is found;
 * all but one are a `data-tutorial` attribute put on the control for this
 * purpose, so restyling a control cannot quietly unhook the tutorial from it.
 */
export type TargetId =
  | "sidebar-settings"
  | "settings-canvas-tab"
  | "project-duration"
  | "sidebar-file"
  | "asset-select-folder"
  | "asset-change-folder"
  | "asset-file"
  | "asset-folder"
  | "timeline-ruler"
  | "sidebar-text"
  | "text-default";

/**
 * What has to happen for a step to count as done. `completion.ts` decides it
 * from two snapshots: the one taken as the step began, and the current one.
 */
export type Completion =
  | { kind: "durationChanged" }
  | { kind: "sidebarTab"; tab: "draft" | "text" }
  | { kind: "folderOpen" }
  | { kind: "elementAdded" }
  | { kind: "playheadMoved" }
  | { kind: "textAdded" };

/**
 * One place a step may point.
 *
 * A step lists several, best first, and the first one on screen wins. The
 * later ones are what the user has to do *before* the step can be done: a
 * user who pressed Next without picking a folder is shown the folder button
 * on the "click a file" step, with `hintKey` saying why. A candidate that is
 * just another way to do the same thing (the toolbar's folder button, once a
 * folder is open) carries no hint.
 */
export interface TargetCandidate {
  target: TargetId;
  hintKey?: string;
}

export type StepId =
  | "duration"
  | "file-tab"
  | "folder"
  | "add-file"
  | "playhead"
  | "text-tab"
  | "add-text";

export interface TutorialStep {
  id: StepId;
  titleKey: string;
  bodyKey: string;
  /** Which side of the target the card prefers; `placement.ts` flips it. */
  side: Side;
  /**
   * Point the arrow at the playhead rather than at the middle of the target.
   * The ruler is the width of the timeline, and its middle is nowhere in
   * particular.
   */
  anchor?: "playhead";
  targets: readonly TargetCandidate[];
  completion: Completion;
}

const hint = (key: string) => `tutorial.hints.${key}`;

export const TUTORIAL_STEPS: readonly TutorialStep[] = [
  {
    id: "duration",
    titleKey: "tutorial.steps.duration.title",
    bodyKey: "tutorial.steps.duration.body",
    side: "right",
    targets: [
      { target: "project-duration" },
      { target: "settings-canvas-tab", hintKey: hint("open_canvas") },
      { target: "sidebar-settings", hintKey: hint("open_settings") },
    ],
    completion: { kind: "durationChanged" },
  },
  {
    id: "file-tab",
    titleKey: "tutorial.steps.file_tab.title",
    bodyKey: "tutorial.steps.file_tab.body",
    side: "right",
    targets: [{ target: "sidebar-file" }],
    completion: { kind: "sidebarTab", tab: "draft" },
  },
  {
    id: "folder",
    titleKey: "tutorial.steps.folder.title",
    bodyKey: "tutorial.steps.folder.body",
    side: "right",
    targets: [
      { target: "asset-select-folder" },
      { target: "asset-change-folder" },
      { target: "sidebar-file", hintKey: hint("open_file_tab") },
    ],
    completion: { kind: "folderOpen" },
  },
  {
    id: "add-file",
    titleKey: "tutorial.steps.add_file.title",
    bodyKey: "tutorial.steps.add_file.body",
    side: "right",
    targets: [
      { target: "asset-file" },
      { target: "asset-folder", hintKey: hint("open_subfolder") },
      { target: "asset-select-folder", hintKey: hint("select_folder_first") },
      { target: "asset-change-folder", hintKey: hint("no_media") },
      { target: "sidebar-file", hintKey: hint("open_file_tab") },
    ],
    completion: { kind: "elementAdded" },
  },
  {
    id: "playhead",
    titleKey: "tutorial.steps.playhead.title",
    bodyKey: "tutorial.steps.playhead.body",
    side: "top",
    anchor: "playhead",
    targets: [{ target: "timeline-ruler" }],
    completion: { kind: "playheadMoved" },
  },
  {
    id: "text-tab",
    titleKey: "tutorial.steps.text_tab.title",
    bodyKey: "tutorial.steps.text_tab.body",
    side: "right",
    targets: [{ target: "sidebar-text" }],
    completion: { kind: "sidebarTab", tab: "text" },
  },
  {
    id: "add-text",
    titleKey: "tutorial.steps.add_text.title",
    bodyKey: "tutorial.steps.add_text.body",
    side: "right",
    targets: [
      { target: "text-default" },
      { target: "sidebar-text", hintKey: hint("open_text_tab") },
    ],
    completion: { kind: "textAdded" },
  },
];

const tagged = (id: TargetId) => `[data-tutorial="${id}"]`;

/**
 * How each target is found in the document.
 *
 * The Canvas sub-tab is the one exception to `data-tutorial`: it is drawn by
 * the shared `<option-tab-bar>`, which already marks each tab with a stable
 * `data-panel`, and adding a tutorial attribute there would put it on every
 * tab bar in the app.
 */
export const TARGET_SELECTORS: Readonly<Record<TargetId, string>> = {
  "sidebar-settings": tagged("sidebar-settings"),
  "settings-canvas-tab": 'control-ui-setting button.opt-tab[data-panel="canvas"]',
  "project-duration": tagged("project-duration"),
  "sidebar-file": tagged("sidebar-file"),
  "asset-select-folder": tagged("asset-select-folder"),
  "asset-change-folder": tagged("asset-change-folder"),
  "asset-file": tagged("asset-file"),
  "asset-folder": tagged("asset-folder"),
  "timeline-ruler": tagged("timeline-ruler"),
  "sidebar-text": tagged("sidebar-text"),
  "text-default": tagged("text-default"),
};

/**
 * Targets that are on screen whatever the user has done: the sidebar's
 * buttons and the ruler. Every step's list ends in one, which is what makes
 * "nothing to point at" a case that only a window too small to draw the
 * editor can reach.
 */
export const ALWAYS_PRESENT: ReadonlySet<TargetId> = new Set<TargetId>([
  "sidebar-settings",
  "sidebar-file",
  "sidebar-text",
  "timeline-ruler",
]);

export const isLastStep = (index: number): boolean =>
  index === TUTORIAL_STEPS.length - 1;

/**
 * The card's "3 / 7". Built here rather than in the locale files, which have
 * no interpolation.
 */
export const counterLabel = (index: number): string =>
  `${index + 1} / ${TUTORIAL_STEPS.length}`;
