import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import {
  applyLocales,
  localeLabel,
} from "../../app/src/features/caption/locale";
import { type CaptionPlacement } from "../../app/src/features/caption/layout";
import {
  hasRemovedLines,
  removedSpans,
  activeAt,
  type CaptionLine,
} from "../../app/src/features/caption/lines";
import {
  applyLineRemoval,
  applyCaptionEdit,
  captionKeyIntent,
  capturesKey,
  editText,
  type CaptionEditor,
  type CaptionKeyIntent,
} from "../../app/src/features/caption/editor";
import { captionRows } from "../../app/src/features/caption/rows";
import { captionEditorLayout } from "../../app/src/features/caption/editorLayout";
import { silenceButtonState } from "../../app/src/features/caption/silenceButton";
import {
  DEFAULT_SILENCE_OPTIONS,
  silenceCuts,
  wordGaps,
} from "../../app/src/features/caption/silence";
import { sourceWindowOf } from "../../app/src/features/caption/cuts";
import {
  ChromeGate,
  PreviewLoop,
  chromeStateOf,
  windowScheduler,
} from "../../app/src/features/caption/previewLoop";
import {
  captionSources,
  sourceDisplayName,
  type CaptionSource,
} from "../../app/src/features/caption/sources";
import { seekMedia } from "../../app/src/features/media/seek";
import {
  displayDurationSec,
  playbackFraction,
  playheadLabel,
} from "../../app/src/features/media/playback";
import { fontsSettled } from "../../app/src/features/element/rasterizeText";
import { paintCaptionPreview } from "../../app/src/features/caption/preview";
import {
  TranscribeSession,
  progressCopy,
  progressPercent,
  type JobProgress,
} from "../../app/src/features/caption/transcribeSession";
import { TransientModal } from "../../app/src/features/ui/transientModal";
import "./progress";

@customElement("automatic-caption")
export class AutomaticCaption extends LitElement {
  isLoadVideo: boolean;
  videoPath: string;
  /** The progress dialog. Gated, because a cached transcript returns instantly. */
  analyzingVideoModal: TransientModal | undefined;
  selectVideoModal: any;
  videoRows: any;
  hasUpdatedOnce: boolean;
  /**
   * Whether the caption editor is showing.
   *
   * This was `panelVideoModal.show()` on a `modal-fullscreen`. It is a plain
   * field now, because the editor is a region inside a window rather than a
   * dialog over the app, and Bootstrap owned its visibility before.
   */
  isEditing: boolean;
  isPlay: boolean;
  /** The two animation-frame handles. See `caption/previewLoop.ts`. */
  private readonly _loop = new PreviewLoop(windowScheduler());

  /** Silences the sweep found, in source ms. Cleared by the Clear button. */
  private _silenceCuts: Array<{ startMs: number; endMs: number }> = [];

  /** A decode is running. One ffmpeg pass, so a spinner rather than a bar. */
  private _silenceBusy = false;

  /** Why the last sweep found nothing, shown rather than swallowed. */
  private _silenceError: string | null = null;
  /** Seconds into the source media. Read from the media element, never accumulated. */
  progress: number;
  /** The element key of the chosen clip. Identifies the row and the source. */
  selectedKey: string | null;
  mediaType: string;
  sttMethod: "apple" | "openai";
  mediaDuration: number;

  /**
   * The captions, as one list.
   *
   * Replaces `analyzedText` (words) and `analyzedEditCaption` (strings), two
   * arrays joined only by a shared index, which drifted the moment anything was
   * edited. See `features/caption/lines.ts`.
   */
  lines: CaptionLine[];
  private _undo: CaptionLine[][];

  /**
   * Vertical placement of the caption block.
   *
   * Deliberately not called "align": `optionsAlign` is the *horizontal*
   * alignment of the text inside its own box, and the panel used to call both
   * axes by the same word.
   */
  private _verticalPlacement: CaptionPlacement;

  /** What the template last showed, so a 60Hz loop does not re-render it. */
  private readonly _chrome = new ChromeGate();

  /**
   * The panel's own box, in px, and what decides the two-column layout.
   *
   * Measured rather than queried in CSS because `captionEditorLayout` has to
   * answer with a number as well as a class: the preview canvas takes a pixel
   * height cap, and a `@media` query could not supply one. It is the *panel's*
   * width and not the viewport's, which is the only one that moves when the
   * window's splitter does.
   */
  private _panelSize = { width: 0, height: 0 };

  private _panelResizeObserver: ResizeObserver | null = null;

  /** Languages this Mac can transcribe, and whether it can at all. */
  locales: { id: string; name: string; installed: boolean }[];
  selectedLocale: string;
  speechAvailable: boolean;
  speechReason: string;

  /** The running job. Null in the web build, which has no bridge behind it. */
  private _session: TranscribeSession | null;
  private _unsubscribeProgress: (() => void) | null;

  constructor() {
    super();

    this.isLoadVideo = false;
    this.isEditing = false;
    this.videoPath = "";
    this.mediaType = "";
    this.lines = [];
    this._undo = [];

    this.analyzingVideoModal = undefined;

    this.selectedKey = null;

    this.hasUpdatedOnce = false;

    this.isPlay = false;
    this.progress = 0;
    this.mediaDuration = 0;

    this.locales = [];
    this.selectedLocale = "";
    this.speechAvailable = false;
    this.speechReason = "";

    this._session = null;
    this._unsubscribeProgress = null;

    this.sttMethod = "apple";
    this._verticalPlacement = "lowerThird";

    // There used to be a `window` keydown listener here that split the caption
    // at the cursor on *any* Enter — including one pressed inside a caption
    // input, which both split the wrong line and discarded the edit being made.
    // Enter is handled on the input itself now. The listener could not have been
    // removed anyway: it was registered with `.bind(this)`, so a second instance
    // of this panel would have split twice per keypress.

    // Audio extraction used to happen here, through the legacy fluent-ffmpeg
    // IPC, with the result arriving as a fire-and-forget event. Main owns the
    // whole job now — extract, then recognise — so there is one promise to
    // await and one place a failure can come from.
    const api = this._transcribeApi();
    if (api != null) {
      this._session = new TranscribeSession(api, uuidv4);
      // `subscribe` filters to our own job, so progress for one we are no longer
      // waiting on never reaches the bar.
      this._unsubscribeProgress = this._session.subscribe(() =>
        this.requestUpdate(),
      );

      api.locales().then((result: any) => {
        // `applyLocales` sorts before choosing and forces `openai` when there is
        // no recogniser — falling back silently would transcribe with OpenAI
        // while the button still said On-device.
        const state = applyLocales(result, this._localePreferences());
        this.speechAvailable = state.available;
        this.speechReason = state.reason;
        this.locales = state.locales;
        this.selectedLocale = state.selectedLocale;
        this.sttMethod = state.method;
        this.requestUpdate();
      });
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._unsubscribeProgress?.();
    this._unsubscribeProgress = null;
    // The animation loop used to outlive the component, going on compositing a
    // full-resolution frame every 16ms against a canvas nobody could see.
    this._stopLoop();
    this.mediaElement()?.pause();
    this._panelResizeObserver?.disconnect();
    this._panelResizeObserver = null;

    // All three of these are new obligations, and they are new because the
    // panel can now be unmounted at all: as a tab pane it was built once and
    // stayed in the DOM for the life of the app, so nothing it held had to be
    // given back. Closing the window destroys it, and reopening builds a fresh
    // one, so anything left behind accumulates once per open.
    this.analyzingVideoModal?.dispose();
    this.selectVideoModal?.dispose?.();
    // A transcription nobody is waiting for. `requestCancel` is a no-op with no
    // job in flight, so this needs no guard of its own.
    this._session?.requestCancel();
  }

  private _stopLoop() {
    this._loop.stop();
  }

  private _transcribeApi(): any {
    // Null in the web build, which has no main process behind the bridge.
    return (window as any).electronAPI?.req?.transcribe ?? null;
  }

  /** What the progress dialog shows. Inert without a bridge. */
  private get _progress(): JobProgress {
    return this._session?.progress ?? { fraction: 0, stage: "" };
  }

  /**
   * The language to offer first.
   *
   * `navigator.languages` is the user's own ranked list, which is more than
   * `navigator.language` alone knows: a Korean user running macOS in English
   * has `ko-KR` in it. The rule itself lives in `features/caption/locale.ts`
   * because this file is outside every test include pattern and getting it
   * wrong is invisible — the first version offered South African English to an
   * `en-US` user and looked entirely reasonable doing it.
   */
  private _localePreferences(): string[] {
    return [...(navigator.languages ?? []), navigator.language ?? ""];
  }

  @query("#previewCanvasCaption") canvas!: HTMLCanvasElement;

  @property()
  timeline: any;

  /**
   * The project's frame, from `Control`.
   *
   * Captions are laid out in these pixels and previewed at this size. The panel
   * used to mix three spaces — `width` from the source clip's native size,
   * `locationY` from a literal 1080, and the element then landing on a canvas
   * sized by the project — so what you positioned was not what you got.
   */
  @property()
  previewSize: { w: number; h: number } = { w: 1920, h: 1080 };

  @property()
  backgroundColor = "#000000";

  @property()
  isDev = false;

  createRenderRoot() {
    return this;
  }

  // ---------------------------------------------------------------- painting

  private mediaElement(): HTMLMediaElement | null {
    return this.querySelector(
      this.mediaType === "audio" ? "#captionPreviewAudio" : "#captionPreviewVideo",
    );
  }

  /**
   * The one place pixels are written.
   *
   * Never called from `render()` or `updated()`: those fire for every unrelated
   * state change — the locale picker, the method toggle, transcription progress
   * — and painting there would couple the paint rate to that noise.
   */
  private redrawPreview(): void {
    const canvas = this.canvas;
    if (canvas == null) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }

    paintCaptionPreview(ctx, {
      // The backing store and the project frame are equal here, because the
      // <canvas> attributes are bound to `previewSize` and CSS does the
      // downscale. They are passed separately because they mean different
      // things — see `caption/preview.ts`.
      canvasSize: { w: canvas.width, h: canvas.height },
      frame: this.previewSize,
      backgroundColor: this.backgroundColor,
      lines: this.lines,
      progressSec: this.progress,
      placement: this._verticalPlacement,
      sourceImage: this.sourceFrame(),
    });
  }

  private sourceFrame(): CanvasImageSource | null {
    if (this.mediaType !== "video") {
      return null;
    }
    const video = this.mediaElement() as HTMLVideoElement | null;
    // `readyState < 2` is HAVE_NOTHING or HAVE_METADATA: no frame to draw yet.
    return video != null && video.readyState >= 2 ? video : null;
  }

  /**
   * The canvas backing store is the project's own frame, and CSS does the
   * downscale — the arrangement `templateThumbnail.ts` and the contact sheet
   * use. Scaling the context instead would leave the wrap width, band padding
   * and outline geometrically right but no longer bit-identical to the export.
   * See the `<canvas>` in `render`: `width:auto; height:auto` under both maxima
   * is what stops a vertical project being stretched, and its column had to
   * stop being `position: fixed` with no box before that could mean anything.
   */

  /** Coalesce repaints through one frame, as `previewCanvas.scheduleDraw` does. */
  private schedulePaint(): void {
    this._loop.schedulePaint(() => this.redrawPreview());
  }

  /**
   * `key` identifies the row, not the path.
   *
   * Two clips cut from one file share a `localpath`, and comparing on that lit
   * up both radio buttons and transcribed whichever came first.
   */
  handleRowSelection(row: CaptionSource) {
    this.selectedKey = row.key;
    this.videoPath = row.localpath;
    this.mediaType = row.filetype;
    this.mediaDuration = row.durationMs;
    this.requestUpdate();
  }

  // 이벤트 처리
  applyCursorEvent(type) {
    this.dispatchEvent(
      new CustomEvent("changeCursorType", {
        detail: {
          type: type,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Transcribe the selected clip.
   *
   * One call into main, which extracts the audio and runs the recogniser. The
   * panel used to do the first half itself through the legacy fluent-ffmpeg IPC
   * and the second half with `axios`, against a server the user had to run and
   * whose URL lived in a DOM input. Both halves are gone: main's `transcribeFile`
   * is the same function the MCP `get_transcript` tool calls, so the two share
   * one disk cache and a clip the agent has already read opens instantly here.
   */
  async transcribeSelectedClip() {
    const session = this._session;
    if (session == null) {
      this._failAnalysis("Transcription needs the desktop app.");
      return;
    }

    const outcome = await session.run(
      {
        source: this.videoPath,
        method: this.sttMethod,
        // The session withholds this for OpenAI, which detects the language.
        locale: this.selectedLocale,
      },
      () => this.requestUpdate(),
    );

    if (outcome.kind === "cancelled") {
      this._endAnalysis();
      return;
    }
    if (outcome.kind === "failed") {
      this._failAnalysis(outcome.message);
      return;
    }

    this.lines = outcome.lines;
    this._undo = [];

    // The editor is a region rather than a second modal now, so the ordering
    // hazard this used to carry is gone: there is no shared `body.modal-open`
    // for two dialogs to fight over in one tick. The progress dialog still has
    // to be closed, and `openEditor` still has to defer the first paint, but
    // for the plainer reason that a canvas has no box until it is in the DOM.
    this.analyzingVideoModal?.close();
    this.openEditor();
  }

  /**
   * Show the caption editor.
   *
   * The first paint is deferred to the render after this one, because the
   * canvas has no layout box until the editor region is in the DOM. As a modal
   * that was hung off `shown.bs.modal`, and before that hook existed the
   * preview stayed blank until the user pressed play, reset, or clicked a word.
   */
  openEditor() {
    if (this.isEditing) {
      return;
    }
    this.isEditing = true;
    this.requestUpdate();

    this.dispatchEvent(
      new CustomEvent("captionEditorOpen", { bubbles: true, composed: true }),
    );

    void this.updateComplete
      .then(() => {
        this._measurePanel();
        return fontsSettled();
      })
      .then(() => this.schedulePaint());
  }

  /**
   * Put the editor away.
   *
   * The one way out, reached from the window's title bar close as well as from
   * finishing an edit. It was two: `hidden.bs.modal` stopped the loop and the
   * footer's own Close button reset `isLoadVideo`, so whichever one a user did
   * not use left the other half undone.
   */
  closeEditor() {
    if (!this.isEditing) {
      return;
    }
    this.isEditing = false;
    this.isLoadVideo = false;
    this.isPlay = false;
    this.mediaElement()?.pause();
    this._stopLoop();
    this.analyzingVideoModal?.close();
    this.applyCursorEvent("pointer");
    this.requestUpdate();

    this.dispatchEvent(
      new CustomEvent("captionEditorClose", { bubbles: true, composed: true }),
    );
  }

  /**
   * Take the editor's keyboard while the caret is inside it, and give it back
   * when it leaves.
   *
   * The panel used to lock the editor's keyboard for as long as it was open,
   * which was right while it was a modal covering the app and is wrong now: the
   * window sits beside the preview and the user is expected to go on cutting on
   * the timeline with it open. Backspace and Delete mean the caption text while
   * the caret is in a caption field, and mean the selected clip everywhere else.
   */
  private _handlePanelFocusIn() {
    if (this.isEditing) {
      this.applyCursorEvent("lockKeyboard");
    }
  }

  private _handlePanelFocusOut(event: FocusEvent) {
    // A move between two fields inside the panel is not a departure. Without
    // this check, tabbing from one caption to the next gives the keyboard back
    // to the timeline for a frame, and a Backspace landing in that gap deletes
    // the clip instead of a character.
    const next = event.relatedTarget as Node | null;
    if (next != null && this.contains(next)) {
      return;
    }
    this.applyCursorEvent("pointer");
  }

  private _measurePanel() {
    const box = this.getBoundingClientRect();
    if (box.width === this._panelSize.width && box.height === this._panelSize.height) {
      return;
    }
    this._panelSize = { width: box.width, height: box.height };
    this.requestUpdate();
    // The canvas is a fixed backing store scaled by CSS, so a resize alone does
    // not need new pixels. It does when the layout crosses the breakpoint and
    // the canvas is handed a different height cap.
    this.schedulePaint();
  }

  /** Give the keyboard back and close the progress modal. */
  _endAnalysis() {
    this.analyzingVideoModal?.close();
    this.isLoadVideo = false;
    this._session?.clear();
    this.applyCursorEvent("pointer");
    this.requestUpdate();
  }

  _failAnalysis(message: string) {
    this._endAnalysis();
    // The old local path swallowed every failure into an empty catch with a
    // `// NOTE: alert 띄우기` beside it, so a server that was not running looked
    // exactly like a clip with no speech in it.
    window.alert(message);
  }

  cancelAnalysis() {
    // Reads the live job id, so it has to run *before* `_endAnalysis` clears it.
    // Reversed, main is sent nothing and silently ignores it, and Cancel appears
    // to work while the job runs on.
    this._session?.requestCancel();
    this._endAnalysis();
  }

  async handleClickLoadVideo() {
    this.videoRows = captionSources(this.timeline);
    this.requestUpdate();

    this.selectVideoModal.show();
  }

  async handleClickSelectVideo() {
    // No `lockKeyboard` here any more. The lock follows the caret instead, in
    // `_handlePanelFocusIn`, because the editor no longer covers the app.
    this.selectVideoModal.hide();
    this.isLoadVideo = true;
    // `videoPath` is set by `handleRowSelection`, from the row's `localpath`.
    // It used to be re-derived here from the field that identifies the row,
    // which was the path once and is the element key now — so this handed a key
    // to ffmpeg and every transcription failed with "No such media file". One
    // name for one value is why the field is `selectedKey` and nothing else.

    // One path for video and audio alike: main runs ffmpeg over whatever it is
    // handed. The panel used to skip extraction for audio and give the file
    // straight to the recogniser, which was two flows and two ways to fail.
    this.analyzingVideoModal?.open();
    this.requestUpdate();

    await this.transcribeSelectedClip();
  }

  handleClickComplate() {

    // `captionRows` drops a line the user emptied, guarantees a positive
    // duration, and applies the same `captionStyle` the preview drew with — so
    // what is placed is what was on screen. `startTime`/`duration` are in the
    // transcribed file's own time, since that is what a transcript timestamps;
    // `Control` converts them to timeline time before placing the captions.
    const result = captionRows(
      this.lines,
      this.selectedKey,
      this.previewSize,
      this._verticalPlacement,
    );

    // `sourceKey` and `cuts` travel beside the rows rather than inside them:
    // they belong to the gesture, not to any one caption. The cuts are source
    // milliseconds, the clock a transcript keeps. `Control` owns the frame rate
    // and the document, so it is where they become timeline ranges.
    this.dispatchEvent(
      new CustomEvent("editComplate", {
        detail: {
          result,
          sourceKey: this.selectedKey,
          cuts: this.pendingCuts(),
        },
        bubbles: true,
        composed: true,
      }),
    );

    this._silenceCuts = [];
    this._silenceError = null;
    // Closing is the same path the title bar's close takes, so a finished edit
    // and an abandoned one leave the panel in exactly one state.
    this.closeEditor();
  }

  /**
   * Where the caption block sits vertically.
   *
   * Repaints. It previously did not — not even `requestUpdate()` — so while the
   * preview was paused, which is the normal state when someone is positioning
   * captions, both buttons appeared to do nothing at all.
   */
  handleClickAlignCaptionButton(placement: CaptionPlacement) {
    this._verticalPlacement = placement;
    this.schedulePaint();
    this.requestUpdate();
  }

  updated() {
    if (this.hasUpdatedOnce == false) {
      this.selectVideoModal = new bootstrap.Modal(
        document.getElementById("SelectVideo"),
        {
          keyboard: false,
        },
      );

      const analyzing = document.getElementById("AnalyzingVideo");
      this.analyzingVideoModal = new TransientModal(
        new bootstrap.Modal(analyzing, { keyboard: false }),
        analyzing!,
      );

      // The editor's own size decides its layout, so the panel watches itself.
      // As a `modal-fullscreen` it had exactly one width and needed none of
      // this; docked beside the preview it is a few hundred pixels wide and
      // both the column split and the canvas cap follow from the measurement.
      this._panelResizeObserver = new ResizeObserver(() => this._measurePanel());
      this._panelResizeObserver.observe(this);
      this._measurePanel();

      // `renderer/text.ts` clears its wrap cache when a face lands, but a
      // cleared cache does not repaint a canvas. The first caption drawn is the
      // one at risk of being measured in the fallback face.
      (document as any).fonts?.addEventListener?.("loadingdone", () =>
        this.schedulePaint(),
      );
    }

    this.hasUpdatedOnce = true;
  }

  // ------------------------------------------------------------ the clock

  /**
   * One animation frame.
   *
   * **`progress` is read from the media element, not accumulated.** The editor
   * deliberately runs its cursor off a wall clock, because it has many handles
   * that must all obey one authoritative time; the panel has exactly one media
   * element and nothing to stay in sync with, so the media *is* the clock.
   * Accumulating rAF timestamps drifted from the audio the user could hear, and
   * `stopVideo` snapshotted the drifted value, so the error compounded across
   * every pause and resume.
   */
  _step() {
    const media = this.mediaElement();
    if (media != null) {
      this.progress = media.currentTime;
    }

    this.redrawPreview();
    this.syncChrome();
  }

  /**
   * Re-render only when something the template shows has actually changed.
   *
   * `_step` used to call `requestUpdate()` every frame, which rebuilt a
   * `TemplateResult` for every word of the whole transcript sixty times a
   * second, on the same thread compositing the frame. Nothing in the template
   * moves that fast: only which word is highlighted, and a readout rounded to
   * whole seconds. Gating on exactly those two drops updates by about two
   * orders of magnitude and changes nothing on screen.
   */
  private syncChrome() {
    // Gated on the string the template actually shows, not on a rounded second —
    // see `ChromeGate`.
    const { active, label } = chromeStateOf(
      this.lines,
      this.progress,
      this.durationSec(),
    );

    if (this._chrome.changed(active, label)) {
      this.requestUpdate();
    }
  }

  /**
   * The length to show, in seconds.
   *
   * The media element's own, not the clip's `duration` — that is the length of
   * its *trimmed span*, while the panel transcribes and plays the whole file.
   * Reading the clip's made the bar reach 100% a third of the way through any
   * trimmed clip, and behave perfectly on the untrimmed ones anyone would test.
   */
  private durationSec(): number {
    return displayDurationSec(
      this.mediaElement()?.duration,
      this.mediaDuration,
    );
  }

  /** Seek the media and wait for a frame, then repaint. */
  private async seekTo(timeSec: number) {
    const media = this.mediaElement();
    if (media == null) {
      return;
    }
    try {
      await seekMedia(media, timeSec);
    } catch {
      // A media element that cannot be read is already visible as a blank
      // preview; there is nothing useful to say about it here.
    }
    this.progress = media.currentTime;
    this.schedulePaint();
    this.syncChrome();
  }

  playVideo() {
    this.isPlay = true;
    // `start` cancels a frame already armed, so double-clicking Play cannot
    // leave two loops compositing the same frame.
    this._loop.start(() => this._step());

    void this.mediaElement()?.play();
    this.requestUpdate();
  }

  stopVideo() {
    this.isPlay = false;
    this.mediaElement()?.pause();
    this._stopLoop();
    this.schedulePaint();
    this.requestUpdate();
  }

  async resetVideo() {
    this.isPlay = false;
    // It used to kill the loop without pausing, so the audio went on playing
    // audibly underneath a frozen canvas.
    this.mediaElement()?.pause();
    this._stopLoop();
    await this.seekTo(0);
    this.requestUpdate();
  }

  /** Seek to a word. The chips are the timing ribbon, and this is what they are for. */
  async clickCaptionText(timeSec: number) {
    this.isPlay = false;
    this.mediaElement()?.pause();
    this._stopLoop();
    await this.seekTo(timeSec);
    this.requestUpdate();
  }

  setSttMethod(method: "apple" | "openai") {
    this.sttMethod = method;
    this.requestUpdate();
  }

  // ----------------------------------------------------------- the editor

  /**
   * `lines` and `_undo` as one value, for `caption/editor.ts`.
   *
   * The two stay separate fields because the template, the preview and
   * `captionRows` all read `this.lines` directly, and Lit re-renders off a
   * manual `requestUpdate()` rather than off reactive state — so moving the
   * list behind an object would mean touching every reader for no gain.
   */
  private _editorState(): CaptionEditor {
    return { lines: this.lines, undo: this._undo };
  }

  /**
   * Carry out one editing intent.
   *
   * `applyCaptionEdit` returns its input **by identity** when the underlying op
   * declined, which is what lets this repaint nothing and record nothing:
   * pressing Enter at the end of a line should cost the user nothing, and the
   * undo stack should not fill with states identical to the one before.
   */
  private _applyIntent(intent: CaptionKeyIntent) {
    const { editor, focus } = applyCaptionEdit(this._editorState(), intent);
    if (editor.lines === this.lines) {
      return;
    }
    this.lines = editor.lines;
    this._undo = editor.undo;
    this.schedulePaint();
    this.requestUpdate();
    if (focus != null) {
      this.focusLine(focus.index, focus.caretOffset);
    }
  }

  /** Undo one split or merge. Typing is not on the stack — see `editText`. */
  undoEdit() {
    this._applyIntent({ kind: "undo" });
  }

  splitLine(index: number, caretOffset: number) {
    this._applyIntent({ kind: "split", index, caretOffset });
  }

  mergeLine(index: number) {
    this._applyIntent({ kind: "merge", index });
  }

  /**
   * Strike a line out, or put it back.
   *
   * Not an intent, because there is no keystroke to cancel; see
   * `editor.ts#applyLineRemoval`. The identity check is the same one
   * `_applyIntent` makes and for the same reason: a second click on an already
   * struck-out line must cost no repaint and no undo entry.
   */
  toggleLineRemoved(index: number, removed: boolean) {
    const editor = applyLineRemoval(this._editorState(), index, removed);
    if (editor.lines === this.lines) {
      return;
    }
    this.lines = editor.lines;
    this._undo = editor.undo;
    this.schedulePaint();
    this.requestUpdate();
  }

  /**
   * Find the silences worth cutting, and offer them.
   *
   * The sweep is a panel field rather than part of `CaptionEditor` on purpose.
   * That editor's undo stack is `CaptionLine[][]`, and the panel's whole
   * "a declined gesture costs nothing" check is `editor.lines === this.lines`.
   * A sweep changes neither, so folding it in would mean rewriting the one line
   * everything else rests on, to serve a gesture with a different lifetime: the
   * lines change per keystroke, a sweep is an async result replaced whole. A
   * deletion needs the undo stack and has it through `removed`; a sweep has a
   * Clear button.
   *
   * `analyzeSilences` is cached on disk by file identity and deduped while it
   * runs, so this is one ffmpeg decode the first time and nothing after.
   */
  async handleClickRemoveSilence() {
    const api = this._analyzeApi();
    const source = this.selectedSource();
    if (api == null || source == null || this._silenceBusy) {
      return;
    }

    this._silenceBusy = true;
    this.requestUpdate();

    try {
      const response = await api.silences({ source: this.videoPath });
      if (response?.ok !== true) {
        this._silenceError =
          response?.error ?? "Could not read the audio for this clip.";
        return;
      }

      // Bounded by the clip's window rather than the file's length: the panel
      // plays the whole file, but only what the clip holds can be cut, and a
      // gap outside it would be clamped away later anyway.
      const window = sourceWindowOf(source);
      if (window == null) {
        return;
      }

      this._silenceError = null;
      this._silenceCuts = silenceCuts(
        response.silences,
        wordGaps(this.lines, window),
        DEFAULT_SILENCE_OPTIONS,
      );
    } catch (error) {
      this._silenceError =
        error instanceof Error ? error.message : String(error);
    } finally {
      this._silenceBusy = false;
      this.requestUpdate();
    }
  }

  /** Put the swept silences back. Nothing has been cut yet either way. */
  clearSilenceCuts() {
    if (this._silenceCuts.length === 0) {
      return;
    }
    this._silenceCuts = [];
    this._silenceError = null;
    this.requestUpdate();
  }

  /**
   * The clip the transcript came from, as it stands in the timeline now.
   *
   * `this.timeline` is the element map, kept fresh by `Control`'s store
   * subscription, so this sees an edit made while the panel was open.
   */
  private selectedSource() {
    return this.selectedKey ? this.timeline?.[this.selectedKey] : undefined;
  }

  /**
   * The silences bridge, or null.
   *
   * Null in the web build, which has no `electronAPI` at all. Same shape and
   * same reason as `_transcribeApi`: the button is hidden rather than throwing.
   */
  private _analyzeApi() {
    return (window as any).electronAPI?.req?.analyze ?? null;
  }

  /** Every range a Complate would cut, in source ms. */
  private pendingCuts() {
    return [...removedSpans(this.lines), ...this._silenceCuts];
  }

  /** Put the caret back where the gesture left it, after Lit has re-rendered. */
  private focusLine(index: number, caretOffset: number) {
    void this.updateComplete.then(() => {
      const input = this.querySelector<HTMLInputElement>(
        `#analyzedEditCaption_${index}`,
      );
      if (input == null) {
        return;
      }
      input.focus();
      const at = Math.min(caretOffset, input.value.length);
      input.setSelectionRange(at, at);
    });
  }

  /**
   * A keystroke in a caption's input.
   *
   * The whole matrix — the IME guard, Enter, Backspace, Delete, Cmd+Z — is
   * `caption/editor.ts#captionKeyIntent`, and `capturesKey` decides whether the
   * keystroke is cancelled. This is a dispatcher over plain numbers, which is
   * what makes the matrix testable without a DOM.
   */
  _handleCaptionKeydown(event: KeyboardEvent, index: number) {
    const input = event.target as HTMLInputElement;
    // Named explicitly, not spread: a DOM event's properties are prototype
    // getters rather than own enumerable ones, so `{ ...event }` is `{}` and
    // every branch below would see an undefined `key`.
    const intent = captionKeyIntent(
      {
        key: event.key,
        isComposing: event.isComposing,
        keyCode: (event as any).keyCode,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      },
      {
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        valueLength: input.value.length,
      },
      index,
      this.lines.length,
    );

    if (!capturesKey(intent)) {
      return;
    }
    event.preventDefault();
    this._applyIntent(intent);
  }

  _handleChangeInput(event: Event, index: number) {
    const value = (event.target as HTMLInputElement).value;
    // Straight to state, no snapshot: typing is the input's own undo to manage.
    this.lines = editText(this._editorState(), index, value).lines;
    this.schedulePaint();
  }

  render() {
    return html`
      <style>
        .caption {
          background-color: #19181a;
          color: #ffffff;
          padding: 0.5rem;
          border: 1px solid #26262b;
          border-radius: 8px;
          cursor: text;
        }

        /* Struck out, not gone: what was deleted stays readable and can be put
           back. A row that vanished would leave nothing to name. */
        .caption-cut .caption-ribbon,
        .caption-cut input {
          text-decoration: line-through;
          opacity: 0.45;
        }

        .caption-cut {
          border-color: #4a2b2b;
        }

        .caption-summary {
          background-color: #19181a;
          border: 1px solid #26262b;
          border-radius: 8px;
          padding: 0.5rem 0.75rem;
          font-size: 0.8rem;
        }

        .caption-part {
          background-color: #1b1a1c;
          color: #ffffff;
          margin-bottom: 0.1rem;
          outline: 1px solid #26262b;
          border-radius: 8px;
          height: fit-content;
          width: fit-content;
          display: inline-block;
        }

        .caption-part.active {
          background-color: #423d47;
          color: #ffffff;
          margin-bottom: 0.1rem;
          border: 2px solid #3838d3;
          border-radius: 8px;
          height: fit-content;
          width: fit-content;
          display: inline-block;
        }

        .caption-part {
          cursor: pointer;
          padding: 0 0.15rem;
        }

        /* The read-only timing ribbon. Clicking a word seeks to it; the text
           below is what gets edited and what gets placed. */
        .caption-ribbon {
          display: flex;
          flex-wrap: wrap;
          gap: 0.15rem;
          user-select: none;
        }

        .caption-merge {
          flex: 0 0 auto;
          line-height: 1;
          padding: 0.25rem 0.4rem;
        }

        .caption-merge .material-symbols-outlined {
          font-size: 1rem;
          vertical-align: middle;
        }
        /* ---------------------------------------------- the window's shape */

        /*
         * The panel fills the window body and pins its own footer. The body
         * above it is overflow:hidden, so the scrolling has to happen here:
         * scrolling there instead would put Apply at the bottom of the caption
         * list rather than at the bottom of the window, which is exactly the
         * failure this panel had as a full-screen modal, where the footer sat
         * below a transcript nobody could reach the end of.
         */
        .caption-panel {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          min-height: 0;
        }

        .caption-panel-body {
          flex: 1 1 auto;
          /* Without this a flex item refuses to shrink below its content and
             the footer is pushed out of the window entirely. */
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
        }

        .caption-panel-footer {
          flex: 0 0 auto;
          display: flex;
          flex-direction: row;
          align-items: center;
          justify-content: flex-end;
          gap: 0.5rem;
          padding: 0.5rem 0.75rem;
          border-top: 1px solid #26262b;
        }

        /* Pushed left so it fills the bar rather than crowding the buttons.
           It is the only text saying what the icon beside Apply just did. */
        .caption-panel-footer .caption-summary {
          margin-right: auto;
          border: none;
          background: transparent;
          padding: 0;
        }

        .caption-silence {
          display: flex;
          align-items: center;
          line-height: 1;
          padding: 0.25rem 0.5rem;
        }

        .caption-silence .material-symbols-outlined {
          font-size: 1.1rem;
        }

        .caption-spin {
          animation: caption-spin 1s linear infinite;
        }

        @keyframes caption-spin {
          to {
            transform: rotate(360deg);
          }
        }

        /* ------------------------------------------------ the two columns */

        .caption-editor {
          display: flex;
          flex-direction: row;
          align-items: flex-start;
          gap: 1rem;
          padding: 0.75rem;
        }

        .caption-editor-preview {
          /* Sticky so the frame stays in view while the transcript scrolls
             past it, which is the whole reason the two are side by side. */
          position: sticky;
          top: 0;
          align-self: flex-start;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .caption-editor-lines {
          flex: 1 1 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        /*
         * Stacked. The switch is decided by caption/editorLayout.ts and
         * applied as this class, not by a media query: a media query answers
         * about the screen, and the screen is the one measurement that does not
         * change when the window's splitter moves.
         */
        .caption-editor.is-stacked {
          flex-direction: column;
        }

        .caption-editor.is-stacked .caption-editor-preview {
          position: static;
          width: 100%;
        }

        .caption-editor-canvas {
          display: block;
          max-width: 100%;
          /* width:auto and height:auto under both maxima is what stops a
             vertical project being stretched. The height cap is an inline
             style, from captionEditorLayout. */
          width: auto;
          height: auto;
          background: #000;
        }

        .caption-setup {
          display: flex;
          flex-direction: column;
          padding: 1rem;
          justify-content: center;
          align-items: center;
          gap: 1rem;
          min-height: 100%;
        }

        /* Nothing in the setup screen grows. Each row is its own height, and
           capped so a wide window leaves a sentence-length control rather than
           a text field the width of the region. */
        .caption-setup > * {
          flex: 0 0 auto;
          width: 100%;
          max-width: 22rem;
        }
      </style>
      <!--
        focusin and focusout rather than a lock held for as long as the editor
        is open. The editor is a window beside the preview now, not a modal over
        it, so taking the timeline's keyboard for the whole session would stop
        the user cutting with the transcript in front of them.
      -->
      <div
        class="caption-panel"
        @focusin=${this._handlePanelFocusIn}
        @focusout=${this._handlePanelFocusOut}
      >
        <div class="caption-panel-body">
          ${this.isEditing ? this.renderEditor() : this.renderSetup()}
        </div>
        ${this.isEditing ? this.renderFooter() : nothing}
      </div>

      <div
        class="modal fade"
        id="AnalyzingVideo"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark">
            <div class="modal-body">
              <h5 class="modal-title text-white font-weight-lg">
                ${progressCopy(this._progress.stage).title}
              </h5>

              <b class="text-secondary"
                >${progressCopy(this._progress.stage).note}</b
              >

              <progress-bar
                percent="${progressPercent(this._progress.fraction)}"
              ></progress-bar>

              <div class="d-flex justify-content-end mt-3">
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  @click=${this.cancelAnalysis}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        class="modal fade"
        id="SelectVideo"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content">
            <div class="modal-body">
              <h5 class="modal-title font-weight-lg">
                Select video from Timeline
              </h5>

              <b class="text-secondary"
                >Selecting the video layer entered on the timeline</b
              >

              <table class="table table-striped ">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Video</th>
                    <th scope="col">Select</th>
                  </tr>
                </thead>
                <tbody>
                  ${this.renderRows()}
                </tbody>
              </table>

              <div class="mt-3">
                <div class="flex row gap-2">
                  <button
                    type="button"
                    class="col btn btn-secondary"
                    data-bs-dismiss="modal"
                  >
                    Close
                  </button>
                  <button
                    ?disabled=${this.selectedKey == null}
                    type="button"
                    class="col btn btn-primary"
                    data-bs-dismiss="modal"
                    @click=${this.handleClickSelectVideo}
                  >
                    Select
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /** Pick a method, pick a language, pick a clip. What the window opens on. */
  renderSetup() {
    return html`<div class="caption-setup">
        <!--
          No Bootstrap col here. In a column flex, col is flex: 1 0 0%, so this
          row grew to fill the whole panel and stretched both buttons the full
          height of the window. Survivable in a full-screen modal that had more
          height than content; obvious the moment the panel is docked.
        -->
        <div class="d-flex gap-2 justify-content-center">
          <button
            @click=${() => this.setSttMethod("apple")}
            ?disabled=${!this.speechAvailable}
            class="btn btn-sm ${this.sttMethod == "apple"
              ? "btn-primary"
              : "btn-default"} text-light"
          >
            On-device
          </button>
          <button
            @click=${() => this.setSttMethod("openai")}
            class="btn btn-sm ${this.sttMethod == "openai"
              ? "btn-primary"
              : "btn-default"} text-light"
          >
            OpenAI
          </button>
        </div>

        ${this.speechAvailable
          ? html``
          : html`<span class="text-secondary" style="font-size: 0.75rem;"
              >${this.speechReason}</span
            >`}

        <div class="input-group ${this.sttMethod == "apple" ? "" : "d-none"}">
          <span class="input-group-text bg-dark text-light">Language</span>
          <select
            id="CartcutSttLocale"
            class="form-select form-control bg-default bg-dark text-light"
            @change=${(e) => {
              this.selectedLocale = e.target.value;
              this.requestUpdate();
            }}
          >
            ${this.locales.map(
              (locale) => html`<option
                value=${locale.id}
                ?selected=${locale.id === this.selectedLocale}
              >
                ${localeLabel(locale)}
              </option>`,
            )}
          </select>
        </div>

        <button
          class="btn btn-sm btn-default text-light mt-1 ${this.isLoadVideo
            ? "d-none"
            : ""}"
          @click=${this.handleClickLoadVideo}
        >
          Load video
        </button>
    </div>`;
  }

  /**
   * The transcript, and the frame it will be drawn on.
   *
   * The column split and the canvas height cap both come from
   * `caption/editorLayout.ts`, which is a pure function with a suite. The panel
   * only applies what it is told.
   */
  renderEditor() {
    // The same pair `syncChrome` gates on, from the same function: these were
    // two independent copies of the same three lines.
    const { lineIndex: activeLine, wordIndex: activeWord } = activeAt(
      this.lines,
      this.progress,
    );

    const layout = captionEditorLayout(this._panelSize);

    const analyzedTextMap = this.lines.map(
      (line, index) => html`<div
        class="text-light caption ${line.removed === true ? "caption-cut" : ""}"
      >
        <div class="caption-ribbon">
          ${line.words.map(
            (word, wordIndex) => html`<span
              @click=${() => this.clickCaptionText(word.start)}
              class="${activeLine === index && activeWord === wordIndex
                ? "caption-part active"
                : "caption-part"}"
              >${word.word}</span
            >`,
          )}
        </div>

        <div class="d-flex gap-1 mt-2 align-items-center">
          <button
            class="btn btn-sm btn-secondary caption-merge"
            ?disabled=${index === 0 || line.removed === true}
            title="Merge into the line above (Backspace at the start of the line)"
            @click=${() => this.mergeLine(index)}
          >
            <span class="material-symbols-outlined icon-white">merge</span>
          </button>
          <button
            class="btn btn-sm btn-secondary caption-merge"
            title=${line.removed === true
              ? "Keep this line, and its footage"
              : "Delete this line and cut its footage out of the video"}
            @click=${() => this.toggleLineRemoved(index, line.removed !== true)}
          >
            <span class="material-symbols-outlined icon-white"
              >${line.removed === true ? "undo" : "content_cut"}</span
            >
          </button>
          <input
            @input=${(e: Event) => this._handleChangeInput(e, index)}
            @keydown=${(e: KeyboardEvent) => this._handleCaptionKeydown(e, index)}
            class="form-control bg-dark text-light"
            type="text"
            id="analyzedEditCaption_${index}"
            ?disabled=${line.removed === true}
            .value=${line.text}
          />
        </div>
      </div>`,
    );

    return html`
      <div
        class="caption-editor ${layout.columns === "one" ? "is-stacked" : ""}"
      >
        <div
          class="caption-editor-preview"
          style=${layout.columns === "two"
            ? `flex: 0 0 ${Math.round(layout.previewShare * 100)}%;`
            : "flex: 0 0 auto;"}
        >
          <canvas
            id="previewCanvasCaption"
            class="caption-editor-canvas"
            width=${this.previewSize.w}
            height=${this.previewSize.h}
            style="max-height: ${layout.canvasMaxHeightPx}px;"
          ></canvas>

          <video
            class="d-none"
            id="captionPreviewVideo"
            src=${this.isDev ? "/test.MOV" : this.videoPath}
          ></video>

          <audio
            class="d-none"
            id="captionPreviewAudio"
            src=${this.videoPath}
          ></audio>

          <span class="text-light font-monospace"
            >${playheadLabel(this.progress, this.durationSec())}</span
          >

          <progress-bar
            percent="${playbackFraction(this.progress, this.durationSec()) * 100}"
          ></progress-bar>

          <!--
            Two flex rows, not Bootstrap's col. A grid class has no business on
            a flex child outside a .row, which is
            the same trap the panel's two columns were in before this.
          -->
          <div class="d-flex gap-2 flex-wrap">
            <button class="btn btn-sm btn-secondary" @click=${this.resetVideo}>
              <span class="material-symbols-outlined icon-white icon-md">
                restart_alt
              </span>
            </button>
            <button
              class="${this.isPlay ? "d-none" : ""} btn btn-sm btn-secondary"
              @click=${this.playVideo}
            >
              <span class="material-symbols-outlined icon-white icon-md">
                play_circle
              </span>
            </button>
            <button
              class="${!this.isPlay ? "d-none" : ""} btn btn-sm btn-danger"
              @click=${this.stopVideo}
            >
              <span class="material-symbols-outlined icon-white icon-md">
                stop_circle
              </span>
            </button>
          </div>

          <div class="d-flex gap-2 flex-wrap">
            <button
              class="btn btn-sm ${this._verticalPlacement == "center"
                ? "btn-primary"
                : "btn-secondary"}"
              @click=${() => this.handleClickAlignCaptionButton("center")}
            >
              align center
            </button>
            <button
              class="btn btn-sm ${this._verticalPlacement == "lowerThird"
                ? "btn-primary"
                : "btn-secondary"}"
              @click=${() => this.handleClickAlignCaptionButton("lowerThird")}
            >
              align bottom
            </button>
          </div>
        </div>

        <div class="caption-editor-lines">${analyzedTextMap}</div>
      </div>
    `;
  }

  /**
   * What the edit will cost, and the two buttons that act on it.
   *
   * Said before Apply is pressed rather than discovered afterwards. An Apply
   * that silently shortens the timeline is the version of this feature nobody
   * could trust.
   *
   * There is no Close button. The window's title bar carries the only one, so
   * there is one way out and it cannot get out of step with the other.
   */
  renderFooter() {
    const pending = this.pendingCuts();
    const pendingMs = pending.reduce(
      (total, cut) => total + Math.max(0, cut.endMs - cut.startMs),
      0,
    );

    // The sweep is an icon and nothing else, so everything it means has to come
    // out of `caption/silenceButton.ts`, where a test can see it.
    const silence = silenceButtonState({
      available: this._analyzeApi() != null,
      busy: this._silenceBusy,
      cutCount: this._silenceCuts.length,
      lineCount: this.lines.length,
    });

    return html`
      <div class="caption-panel-footer">
        ${this._silenceError != null
          ? html`<span class="caption-summary text-warning"
              >${this._silenceError}</span
            >`
          : pending.length === 0
            ? nothing
            : html`<span class="caption-summary text-light">
                ${pending.length} cut${pending.length === 1 ? "" : "s"},
                ${(pendingMs / 1000).toFixed(1)}s removed when you finish.
              </span>`}

        ${silence == null
          ? nothing
          : html`<button
              type="button"
              class="btn btn-sm btn-${silence.variant} caption-silence"
              ?disabled=${silence.disabled}
              title=${silence.label}
              aria-label=${silence.label}
              @click=${() =>
                silence.action === "clear"
                  ? this.clearSilenceCuts()
                  : void this.handleClickRemoveSilence()}
            >
              <span
                class="material-symbols-outlined icon-white ${silence.busy
                  ? "caption-spin"
                  : ""}"
                >${silence.icon}</span
              >
            </button>`}

        <button
          type="button"
          class="btn btn-sm btn-primary caption-apply"
          @click=${this.handleClickComplate}
        >
          Apply
        </button>
      </div>
    `;
  }


  renderRows() {
    if (!Array.isArray(this.videoRows)) {
      return html``;
    }

    return this.videoRows.map(
      (row) => html`
        <tr @click=${() => this.handleRowSelection(row)}>
          <th scope="row">${row.id}</th>
          <td class="text-truncate" style="max-width: 26rem;" title=${row.localpath}>
            ${sourceDisplayName(row.localpath)}
          </td>
          <td>
            <input
              type="radio"
              name="videoSelect"
              .checked=${this.selectedKey === row.key}
            />
          </td>
        </tr>
      `,
    );
  }
}
