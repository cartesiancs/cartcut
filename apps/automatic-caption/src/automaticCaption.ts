import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import {
  applyLocales,
  localeLabel,
} from "../../app/src/features/caption/locale";
import { type CaptionPlacement } from "../../app/src/features/caption/layout";
import {
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
import { silenceButtonState } from "../../app/src/features/caption/silenceButton";
import {
  captionPlacementButton,
  captionPlacementMenu,
  captionRowMenu,
  menuPlacement,
  type CaptionRowAction,
  type MenuAnchor,
  type MenuPoint,
} from "../../app/src/features/caption/menus";
import {
  captionPhaseView,
  type CaptionPhase,
} from "../../app/src/features/caption/captionPhase";
import type { CaptionSessionPhase } from "../../app/src/features/caption/captionSession";
import type { CaptionPlayheadPort } from "../../app/src/features/caption/playheadPort";
import {
  DEFAULT_SILENCE_OPTIONS,
  silenceCuts,
  wordGaps,
} from "../../app/src/features/caption/silence";
import { sourceWindowOf } from "../../app/src/features/caption/cuts";
import {
  ChromeGate,
  chromeStateOf,
} from "../../app/src/features/caption/previewLoop";
import {
  captionSources,
  sourceDisplayName,
  type CaptionSource,
} from "../../app/src/features/caption/sources";
import { TranscribeSession } from "../../app/src/features/caption/transcribeSession";
import "./progress";

@customElement("automatic-caption")
export class AutomaticCaption extends LitElement {
  isLoadVideo: boolean;
  videoPath: string;
  selectVideoModal: any;
  videoRows: any;
  hasUpdatedOnce: boolean;

  /**
   * What the panel is doing, and therefore which of three bodies it draws.
   *
   * It replaced `isEditing`, which was a boolean because there were only ever
   * two states worth drawing: the setup form, and the editor. The work between
   * them was a Bootstrap dialog over the whole app. That dialog is gone, and
   * the phases it used to hide are the panel's own body now, which is what
   * "show progress in the window rather than over the app" amounts to.
   *
   * `captionPhase.ts` decides what each one says. Nothing here does.
   */
  phase: CaptionPhase = "setup";

  /** Why the last transcription failed, shown on the `failed` screen. */
  private _failMessage: string | null = null;

  /**
   * The silences the sweep found, in source ms.
   *
   * Kept whole and kept for the whole session, because the toggle needs them
   * back. Turning the cuts off does not put a cut back, which has no inverse:
   * it sends a shorter list of ranges and the session rebuilds from its
   * baseline. So this list is the thing that has to survive, not the cuts.
   */
  private _silenceRanges: Array<{ startMs: number; endMs: number }> = [];

  /** Whether those gaps are currently cut out of the timeline. */
  private _silenceOn = true;

  /** A decode is running. One ffmpeg pass, so a spinner rather than a bar. */
  private _silenceBusy = false;

  /** Why the last sweep found nothing, shown rather than swallowed. */
  private _silenceError: string | null = null;

  /**
   * The clip's window into its source file, read when the transcript landed.
   *
   * Held rather than looked up, and that is the same rule `applyCaptions.ts`
   * states: the session cuts the clip within a second of this being set, and
   * `removeRanges` does not always leave the original id behind. Asking
   * `this.timeline[selectedKey]` afterwards gets `undefined` for an entirely
   * ordinary case, and `wordGaps` would then be bounded by nothing.
   */
  private _sourceWindow: { startMs: number; endMs: number } | null = null;

  /** The element key of the chosen clip. Identifies the row and the source. */
  selectedKey: string | null;
  sttMethod: "apple" | "openai";

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

  /** What the template last showed, so a 60Hz playhead does not re-render it. */
  private readonly _chrome = new ChromeGate();

  /** Where the playhead is, in source seconds. Fed by the `playhead` port. */
  private _progressSec = 0;

  private _unsubscribePlayhead: (() => void) | null = null;

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
    this.videoPath = "";
    this.lines = [];
    this._undo = [];

    this.selectedKey = null;

    this.hasUpdatedOnce = false;

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
    this._unsubscribePlayhead?.();
    this._unsubscribePlayhead = null;
    // Four window listeners, live only while a menu is open. Closing the window
    // with one open would otherwise leave them holding this panel.
    this._unbindMenuDismiss();
    this._menu = null;

    // These are new obligations, and they are new because the panel can now be
    // unmounted at all: as a tab pane it was built once and stayed in the DOM
    // for the life of the app, so nothing it held had to be given back. Closing
    // the window destroys it, and reopening builds a fresh one, so anything
    // left behind accumulates once per open.
    this.selectVideoModal?.dispose?.();
    // A transcription nobody is waiting for. `requestCancel` is a no-op with no
    // job in flight, so this needs no guard of its own.
    this._session?.requestCancel();

    // The session itself is *not* cancelled here. An event dispatched from a
    // detached element reaches nobody, so `Control` does it from the window's
    // own close, which is the same reason the keyboard is given back there.
  }

  private _transcribeApi(): any {
    // Null in the web build, which has no main process behind the bridge.
    return (window as any).electronAPI?.req?.transcribe ?? null;
  }

  /** What the progress screen shows. Inert without a bridge. */
  private get _progress(): { fraction: number; stage: string } {
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

  @property()
  timeline: any;

  /**
   * The project's frame, from `Control`.
   *
   * Captions are laid out as fractions of it, which is what decides where the
   * words sit and how big they are. The panel used to mix three spaces:
   * `width` from the source clip's native size, `locationY` from a literal
   * 1080, and the element then landing on a canvas sized by the project. So
   * what you positioned was not what you got.
   */
  @property()
  previewSize: { w: number; h: number } = { w: 1920, h: 1080 };

  /**
   * The app's playhead, in source seconds, both ways.
   *
   * The panel had its own `<video>`, its own canvas and its own clock. It has
   * none of them now: the captions are on the real timeline from the moment a
   * transcript lands, so the app's preview is the preview and its playhead is
   * the clock. See `features/caption/playheadPort.ts` for why this is a port
   * and not a property carrying the cursor.
   */
  @property({ attribute: false })
  playhead: CaptionPlayheadPort | null = null;

  /**
   * What the session is doing, from `Control`.
   *
   * The panel cannot tell when the reveal has finished; only the session can,
   * and this is how it says so. Written twice per session, not per frame.
   */
  @property()
  sessionPhase: CaptionSessionPhase = "idle";

  @property()
  isDev = false;

  createRenderRoot() {
    return this;
  }

  // --------------------------------------------------------- the playhead

  /**
   * Follow the app's playhead, and re-render only when something moved.
   *
   * `ChromeGate` is why this can be a subscription at all: the cursor changes
   * at the display's rate, and the only things in this template that depend on
   * it are which word is highlighted and which line is active. Gating on
   * exactly those drops the re-renders by about two orders of magnitude, which
   * is the measurement `previewLoop.test.ts` pins. Without it, Lit would
   * rebuild a `TemplateResult` for every word of the transcript sixty times a
   * second.
   */
  private _watchPlayhead(): void {
    if (this._unsubscribePlayhead != null || this.playhead == null) {
      return;
    }
    const port = this.playhead;
    this._unsubscribePlayhead = port.subscribe(() => {
      this._progressSec = port.sourceSeconds();
      this._syncChrome();
    });
    this._progressSec = port.sourceSeconds();
  }

  private _syncChrome(): void {
    // Gated on the string the template actually shows, not on a rounded second.
    // The duration is no longer part of it: the readout that needed one went
    // with the preview column, and the app's own transport shows the time.
    const { active, label } = chromeStateOf(this.lines, this._progressSec, 0);
    if (this._chrome.changed(active, label)) {
      this.requestUpdate();
    }
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
    // `filetype` and `durationMs` used to be kept here, for a hidden media
    // element and a playback readout that are both gone. The panel does not
    // play anything any more, so a row is a key and a path and nothing else.
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

    // Read the clip's window now, before the session cuts it. After that the
    // original id may name a piece or nothing at all.
    this._sourceWindow = sourceWindowOf(this.selectedSource()) ?? null;

    // The sweep used to be a button the user pressed, and pressing it was the
    // only way to find out whether there was anything to cut. It is part of the
    // same run now: one press gets a transcript, the silences gone and the
    // words on the timeline, which is the whole gesture anybody wanted.
    await this.sweepSilence();

    this._startSession();
  }

  /**
   * Find the silences worth cutting.
   *
   * Both halves must agree: the signal (an absolute dBFS threshold over an RMS
   * envelope, from `analyze:silences`) and the **words**. The signal alone cuts
   * a word quiet enough to dip under the threshold and keeps laughter; the
   * words alone call every wordless gap dead air, sting included.
   *
   * `analyzeSilences` is cached on disk by file identity and deduped while it
   * runs, so this is one ffmpeg decode the first time and nothing after. A
   * failure leaves the list empty and the reason on the footer: there is still
   * a transcript to place, so it is a part of the run that can fail on its own.
   */
  private async sweepSilence(): Promise<void> {
    const api = this._analyzeApi();
    const window = this._sourceWindow;
    if (api == null || window == null) {
      return;
    }

    this._silenceBusy = true;
    this.phase = "sweeping";
    this.requestUpdate();

    try {
      const response = await api.silences({ source: this.videoPath });
      if (response?.ok !== true) {
        this._silenceError =
          response?.error ?? "Could not read the audio for this clip.";
        return;
      }

      this._silenceError = null;
      this._silenceRanges = silenceCuts(
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

  /**
   * Hand the whole edit to the session, which takes the timeline.
   *
   * From here until Apply or a close, the document in the store is a projection
   * of what this panel says, and the timeline is locked so nothing else can
   * write to it. The panel's job for the rest of the session is to say what
   * changed.
   */
  private _startSession(): void {
    this._silenceOn = true;
    this.phase = "revealing";
    this.isLoadVideo = false;
    this.requestUpdate();

    this.dispatchEvent(
      new CustomEvent("captionSessionStart", {
        detail: {
          lines: this.lines,
          sourceKey: this.selectedKey,
          placement: this._verticalPlacement,
          sourceRanges: this._sourceRanges(),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Every range the session should cut, in source ms.
   *
   * Two gestures, one list, and they are the same thing by the time they get
   * here: a struck-out caption line contributes its own span, and the sweep
   * contributes what the signal and the words agreed on. The toggle decides
   * only whether the second half is included.
   */
  private _sourceRanges(): Array<{ startMs: number; endMs: number }> {
    return [
      ...removedSpans(this.lines),
      ...(this._silenceOn ? this._silenceRanges : []),
    ];
  }

  /**
   * Tell the session something changed.
   *
   * Called from every edit: a keystroke, a split, a merge, a strike-out, a
   * realignment, the toggle. One event for all of them, because the session
   * rebuilds its projection from the baseline either way and does not care
   * which of them it was. The session coalesces these into one frame, so
   * calling it per keystroke is what it expects.
   */
  private _emitChange(): void {
    if (this.sessionPhase === "idle") {
      return;
    }
    this.dispatchEvent(
      new CustomEvent("captionSessionChange", {
        detail: {
          lines: this.lines,
          placement: this._verticalPlacement,
          sourceRanges: this._sourceRanges(),
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Put the panel away.
   *
   * The one way out, reached from the window's title bar close as well as from
   * Apply. It was two: `hidden.bs.modal` stopped the loop and the footer's own
   * Close button reset `isLoadVideo`, so whichever one a user did not use left
   * the other half undone.
   *
   * It does **not** end the session. Apply ends it by committing and the window
   * close ends it by discarding, and both of those are decided in `Control`,
   * which is the only thing that outlives this element.
   */
  closeEditor() {
    if (this.phase === "setup") {
      return;
    }
    this.phase = "setup";
    this.isLoadVideo = false;
    this._silenceRanges = [];
    this._silenceError = null;
    this._sourceWindow = null;
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
    if (this.phase === "live") {
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

  /** Back to the setup screen, with the keyboard given up. */
  _endAnalysis() {
    this.phase = "setup";
    this.isLoadVideo = false;
    this._session?.clear();
    this.applyCursorEvent("pointer");
    this.requestUpdate();
  }

  /**
   * Say what went wrong, on the panel rather than in an alert.
   *
   * The old local path swallowed every failure into an empty catch with a
   * `// NOTE: alert 띄우기` beside it, so a server that was not running looked
   * exactly like a clip with no speech in it. Then it was a `window.alert`,
   * which is a modal dialog over the whole app for something that concerns one
   * docked window and has a Try again beside it here.
   */
  _failAnalysis(message: string) {
    this._session?.clear();
    this.isLoadVideo = false;
    this._failMessage = message;
    this.phase = "failed";
    this.applyCursorEvent("pointer");
    this.requestUpdate();
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
    //
    // The progress used to be a Bootstrap dialog opened here, behind a 180ms
    // gate so a cached transcript would not flash one. There is no gate any
    // more and none is needed: the run does not end with the transcript, it
    // goes on into the sweep and the reveal, so there is no instant path to
    // flicker.
    this.phase = "transcribing";
    this.requestUpdate();

    await this.transcribeSelectedClip();
  }

  /**
   * Apply.
   *
   * The captions and the cuts are already on the timeline and have been since
   * the transcript landed. What this does is make them the user's: the session
   * records one undo step holding exactly what is on screen, gives the timeline
   * back, and the panel returns to its setup screen.
   *
   * It carries no payload. Everything it would have said has been said on every
   * change since the session began, which is what "the panel edits the timeline
   * directly" means.
   */
  handleClickComplate() {
    this.dispatchEvent(
      new CustomEvent("captionSessionApply", { bubbles: true, composed: true }),
    );
    // Closing is the same path the title bar's close takes, so a finished edit
    // and an abandoned one leave the panel in exactly one state.
    this.closeEditor();
  }

  /**
   * Where the caption block sits vertically.
   *
   * Re-projects, so the captions move on the timeline as the button is pressed.
   * It previously repainted a canvas in this panel, and before that it did not
   * even `requestUpdate()`. So while the preview was paused, which is the
   * normal state when someone is positioning captions, both buttons appeared to
   * do nothing at all.
   */
  handleClickAlignCaptionButton(placement: CaptionPlacement) {
    if (this._verticalPlacement === placement) {
      return;
    }
    this._verticalPlacement = placement;
    this._emitChange();
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
    }

    // The port arrives as a property, so it cannot be subscribed to in the
    // constructor. `_watchPlayhead` is idempotent and cheap, so asking on every
    // update is simpler than a second flag to get wrong.
    this._watchPlayhead();

    // The panel cannot tell when the reveal has finished. It knows how many
    // captions there are, but not the pace, and re-deriving the pace here would
    // be a second copy of `captionReveal.ts` that could disagree with the one
    // driving the animation. So the session says, through `Control`, and the
    // panel swaps its "Applying to the timeline" screen for the transcript.
    if (this.phase === "revealing" && this.sessionPhase === "live") {
      this.phase = "live";
      this.requestUpdate();
    }

    // After the template, so the menu it may have just rendered is in the DOM
    // and can be measured.
    this._placeMenu();

    this.hasUpdatedOnce = true;
  }

  /**
   * Seek to a word.
   *
   * The chips are the timing ribbon, and this is what they are for. It moves
   * the **app's** playhead now, through the port, so the preview the user is
   * already looking at jumps to the word. It used to seek a hidden `<video>`
   * behind a canvas in this panel, which was a second copy of the same footage
   * playing on a second clock.
   */
  clickCaptionText(timeSec: number) {
    this.playhead?.seekToSource(timeSec);
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
    this._emitChange();
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
   * struck-out line must cost no rebuild and no undo entry.
   *
   * It cuts the picture as well as the words, and it does so at once: the
   * line's span joins the ranges the session is asked to remove, so the footage
   * under a struck-out caption goes as the button is pressed.
   */
  toggleLineRemoved(index: number, removed: boolean) {
    const editor = applyLineRemoval(this._editorState(), index, removed);
    if (editor.lines === this.lines) {
      return;
    }
    this.lines = editor.lines;
    this._undo = editor.undo;
    this._emitChange();
    this.requestUpdate();
  }

  // ------------------------------------------------------- the menus

  /**
   * The one menu that can be open, whichever trigger opened it.
   *
   * One field and not two, so that opening either menu closes the other and
   * there is a single set of window listeners to give back. `kind` is what the
   * template switches on: `"line"` carries the line it belongs to.
   *
   * `position` is null for exactly one frame. A menu has to be in the DOM
   * before its height can be measured, and `menuPlacement` needs that height to
   * decide whether it opens downwards; the template keeps it hidden until
   * `updated` has answered rather than letting it flash at the wrong place.
   */
  private _menu: {
    kind: "line" | "placement";
    /** The line, for `"line"`. Ignored otherwise. */
    index: number;
    anchor: MenuAnchor;
    position: MenuPoint | null;
  } | null = null;

  /**
   * Open a menu, or close the one this trigger already has open.
   *
   * The anchor is read here, once, rather than on every placement: a trigger
   * can be inside a scroller and the menu is `position: fixed`, so a rect
   * captured later would be a different rect. A scroll closes the menu for the
   * same reason.
   */
  private _toggleMenu(
    event: MouseEvent,
    kind: "line" | "placement",
    index = -1,
  ) {
    // The window-level listener that dismisses the menu would otherwise see the
    // very click that opened it.
    event.stopPropagation();

    if (this._menu?.kind === kind && this._menu.index === index) {
      this._closeMenu();
      return;
    }

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const wasOpen = this._menu != null;
    this._menu = {
      kind,
      index,
      anchor: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      position: null,
    };
    if (!wasOpen) {
      this._bindMenuDismiss();
    }
    this.requestUpdate();
  }

  /** An arrow property because it is added to and removed from `window`. */
  private readonly _closeMenu = () => {
    if (this._menu == null) {
      return;
    }
    this._menu = null;
    this._unbindMenuDismiss();
    this.requestUpdate();
  };

  private readonly _closeMenuOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      this._closeMenu();
    }
  };

  private _bindMenuDismiss() {
    window.addEventListener("click", this._closeMenu);
    window.addEventListener("resize", this._closeMenu);
    window.addEventListener("keydown", this._closeMenuOnEscape);
    // Capture, because a scroll does not bubble: the transcript scrolls in its
    // own `overflow-y: auto` box, and a menu placed against the viewport does
    // not follow the row it belongs to.
    window.addEventListener("scroll", this._closeMenu, true);
  }

  private _unbindMenuDismiss() {
    window.removeEventListener("click", this._closeMenu);
    window.removeEventListener("resize", this._closeMenu);
    window.removeEventListener("keydown", this._closeMenuOnEscape);
    window.removeEventListener("scroll", this._closeMenu, true);
  }

  /**
   * Measure the open menu and place it, the frame after it is rendered.
   *
   * Idempotent: it does nothing once `position` is set, which is what stops the
   * `requestUpdate` below from looping.
   */
  private _placeMenu() {
    const open = this._menu;
    if (open == null || open.position != null) {
      return;
    }
    const el = this.querySelector(".caption-menu") as HTMLElement | null;
    if (el == null) {
      return;
    }
    const rect = el.getBoundingClientRect();
    open.position = menuPlacement(
      open.anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.requestUpdate();
  }

  private _runRowMenu(action: CaptionRowAction, index: number) {
    this._closeMenu();
    if (action === "merge") {
      this.mergeLine(index);
      return;
    }
    this.toggleLineRemoved(index, action === "remove");
  }

  private _runPlacementMenu(placement: CaptionPlacement) {
    this._closeMenu();
    this.handleClickAlignCaptionButton(placement);
  }

  /**
   * Turn the silence cuts off, or back on.
   *
   * A true toggle now, and the reason is that there is nothing left for it to
   * *start*: the sweep runs as part of the transcription, so by the time anyone
   * sees this button the gaps are already gone from the timeline. It used to
   * mean "go and look" the first time and "put them back" afterwards, which is
   * a control that changes meaning under the user.
   *
   * Neither direction undoes anything. `removeRanges` has no inverse; both
   * states are built from the session's baseline, which is why switching the
   * cuts off and on again lands on exactly the same document.
   */
  toggleSilence(on: boolean) {
    if (this._silenceOn === on || this._silenceRanges.length === 0) {
      return;
    }
    this._silenceOn = on;
    this._emitChange();
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
    const next = editText(this._editorState(), index, value).lines;
    if (next === this.lines) {
      return;
    }
    this.lines = next;
    // Straight onto the timeline. The session coalesces a burst of these into
    // one rebuild per frame, so typing at speed costs one write per frame and
    // not one per key.
    this._emitChange();
  }

  render() {
    return html`
      <style>
        .caption {
          background-color: #19181a;
          color: #ffffff;
          padding: 0.5rem;
          border-radius: 10px;
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

        /* Every word keeps the same box whether or not it is the active one.
           The highlight used to be a 2px border, which added 4px to the active
           word and shoved the rest of the line sideways on every playhead
           step. It is a pseudo-element now: an overlay takes no space. */
        .caption-part {
          position: relative;
          z-index: 0;
          background-color: #1b1a1c;
          color: #ffffff;
          margin-bottom: 0.1rem;
          outline: 1px solid #26262b;
          border-radius: 8px;
          height: fit-content;
          width: fit-content;
          display: inline-block;
          cursor: pointer;
          padding: 0 0.15rem;
          transition: outline-color 120ms ease-in;
        }

        /* A negative z-index child paints over the element's own background
           and under its text, so the word stays readable on the fill. */
        .caption-part::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          border-radius: 8px;
          background-color: #3838d3;
          transform-origin: center;
          transform: scale(0.72);
          opacity: 0;
          /* Leaving: short and plain, so the highlight is gone before the next
             word's springs in. */
          transition:
            transform 120ms ease-in,
            opacity 110ms ease-in;
        }

        .caption-part.active {
          outline-color: transparent;
        }

        /* Arriving: a damped spring, zeta 0.66, settling in 420ms with about
           6% overshoot. The opacity leads it so the fill is there before the
           scale finishes. */
        .caption-part.active::before {
          transform: scale(1);
          opacity: 1;
          transition:
            transform 420ms
              linear(
                0,
                0.055,
                0.186,
                0.35,
                0.519,
                0.672,
                0.802,
                0.902,
                0.975,
                1.022,
                1.05,
                1.062,
                1.063,
                1.057,
                1.048,
                1.037,
                1.027,
                1.017,
                1.01,
                1.004,
                1,
                0.998,
                0.996,
                0.996,
                0.996,
                0.997,
                0.997,
                0.998,
                1
              ),
            opacity 90ms linear;
        }

        @media (prefers-reduced-motion: reduce) {
          .caption-part::before,
          .caption-part.active::before {
            transition-duration: 1ms;
            transform: none;
          }
        }

        /* The read-only timing ribbon. Clicking a word seeks to it; the text
           below is what gets edited and what gets placed. */
        .caption-ribbon {
          display: flex;
          flex-wrap: wrap;
          gap: 0.15rem;
          user-select: none;
        }

        /* The !important is not decoration: devent-designsystem.css sets
           .btn padding to .7rem 1.55rem !important, which is what made these
           icon buttons as wide as a word of text. */
        .caption-merge {
          flex: 0 0 auto;
          line-height: 1;
          padding: 0.25rem 0.35rem !important;
        }

        .caption-merge .material-symbols-outlined {
          font-size: 1rem;
          vertical-align: middle;
        }

        /* ------------------------------------------- the per-line menu */

        /*
         * Fixed, not absolute: the transcript scrolls inside the panel body's
         * overflow-y: auto, which would clip an absolutely positioned menu at
         * the row it belongs to. The price is that it does not move with its
         * row, which is why a scroll closes it.
         *
         * Placed by caption/menus.ts#menuPlacement, from a measurement
         * taken in updated(). Nothing here may set left or top, or the menu is
         * in two places at once and the one that wins depends on which rule
         * the browser saw last.
         */
        .caption-menu {
          position: fixed;
          z-index: 9100;
          display: flex;
          flex-direction: column;
          gap: 0.1rem;
          min-width: 13rem;
          max-width: 19rem;
          padding: 0.25rem;
          background-color: #19181a;
          border: 1px solid #26262b;
          border-radius: 8px;
          box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.5);
        }

        .caption-menu-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          width: 100%;
          padding: 0.35rem 0.5rem;
          border: none;
          border-radius: 6px;
          background-color: transparent;
          color: #ffffff;
          font-size: 0.8rem;
          line-height: 1.2;
          text-align: left;
          cursor: pointer;
        }

        .caption-menu-label {
          flex: 1 1 auto;
        }

        /* Pushed to the far edge and dimmed: it names a key, and reading it as
           part of the sentence would make the entry say two things. */
        .caption-menu-hint {
          flex: 0 0 auto;
          margin-left: 0.75rem;
          color: #8a8a94;
          font-size: 0.7rem;
        }

        .caption-menu-item:hover:not(:disabled) {
          background-color: #26262b;
        }

        .caption-menu-item:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .caption-menu-item .material-symbols-outlined {
          font-size: 1.05rem;
        }

        /* Where the line menu puts its keystroke, and dimmer than the label:
           it marks the entry rather than naming a third thing. */
        .caption-menu-check {
          flex: 0 0 auto;
          margin-left: 0.75rem;
          color: #8a8a94;
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

        /* The footer's icon-only buttons: the silence toggle and the caption
           placement trigger. The !important is the same one .caption-merge
           needs, against devent-designsystem.css setting .btn padding to
           .7rem 1.55rem !important, which sizes a one-glyph button for a word
           of text. */
        .caption-icon-btn {
          display: flex;
          align-items: center;
          line-height: 1;
          padding: 0.3rem 0.4rem !important;
        }

        .caption-icon-btn .material-symbols-outlined {
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

        /* -------------------------------------------------- the transcript */

        /*
         * One column. It was two, with a preview canvas beside the lines and a
         * breakpoint in caption/editorLayout.ts deciding whether they fitted
         * side by side. Both went with the canvas: the captions are on the real
         * timeline while this panel is open, so the app's own preview is the
         * preview and this is just the words.
         *
         * No backticks in here. This is inside an html template literal, so one
         * would end it, and the error lands on a line some way below.
         */
        .caption-editor-lines {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          padding: 0.75rem;
        }

        /*
         * The working screens: transcribing, sweeping, applying, failed.
         *
         * Centred in the panel rather than laid out at the top, because each of
         * them is the only thing on screen for as long as it lasts, and a
         * heading pinned to the top of an otherwise empty region reads as
         * content that failed to load.
         */
        .caption-phase {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          text-align: center;
          gap: 0.75rem;
          padding: 1rem;
          min-height: 100%;
        }

        .caption-phase > * {
          flex: 0 0 auto;
          width: 100%;
          max-width: 22rem;
        }

        .caption-phase .material-symbols-outlined {
          font-size: 2rem;
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
        <div class="caption-panel-body">${this.renderBody()}</div>

        ${this.phase === "live" ? this.renderFooter() : nothing}
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

  /**
   * One of three bodies, and the phase decides which.
   *
   * `captionPhaseView` answers `null` for the two phases that have a body of
   * their own and a screen for the three that are work in progress. That
   * split is the whole of "show progress in the window rather than over the
   * app": the states that used to be hidden behind a Bootstrap dialog are
   * ordinary contents of this panel now.
   */
  renderBody() {
    const view = captionPhaseView({
      phase: this.phase,
      stage: this._progress.stage,
      fraction: this._progress.fraction,
      message: this._failMessage ?? undefined,
    });

    if (view != null) {
      return this.renderPhase(view);
    }
    return this.phase === "live" ? this.renderEditor() : this.renderSetup();
  }

  /**
   * Working.
   *
   * A bar when there is a fraction worth drawing and a spinner when there is
   * not. A bar sitting at zero through a real decode says the work has not
   * started, which is the one thing it must not say.
   */
  renderPhase(view: NonNullable<ReturnType<typeof captionPhaseView>>) {
    return html`
      <div class="caption-phase">
        <h6 class="text-light m-0">${view.title}</h6>
        <b class="${view.failed ? "text-warning" : "text-secondary"}"
          >${view.note}</b
        >

        ${view.percent == null
          ? html`<span
              class="material-symbols-outlined icon-white caption-spin"
              aria-hidden="true"
              >progress_activity</span
            >`
          : html`<progress-bar percent="${view.percent}"></progress-bar>`}
        ${view.cancellable
          ? html`<button
              type="button"
              class="btn btn-sm btn-secondary"
              @click=${this.cancelAnalysis}
            >
              Cancel
            </button>`
          : nothing}
        ${this.phase === "failed"
          ? html`<button
              type="button"
              class="btn btn-sm btn-primary"
              @click=${this._endAnalysis}
            >
              Try again
            </button>`
          : nothing}
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
            (locale) =>
              html`<option
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
        Select
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
  /**
   * The transcript, as one editable column.
   *
   * It was two columns: a preview canvas on the left playing the source file,
   * and the lines on the right. The canvas is gone and so is the breakpoint
   * that decided whether the two fitted side by side, because the captions are
   * on the real timeline while this is open and the app's own preview is
   * showing them. Two previews of one edit is one too many, and the one that
   * went is the one that could disagree.
   */
  renderEditor() {
    // The same pair `_syncChrome` gates on, from the same function: these were
    // two independent copies of the same three lines.
    const { lineIndex: activeLine, wordIndex: activeWord } = activeAt(
      this.lines,
      this._progressSec,
    );

    return html`
      <div class="caption-editor-lines">
        ${this.lines.map(
          (line, index) =>
            html`<div
              class="text-light caption ${line.removed === true
                ? "caption-cut"
                : ""}"
            >
              <div class="caption-ribbon">
                ${line.words.map(
                  (word, wordIndex) =>
                    html`<span
                      @click=${() => this.clickCaptionText(word.start)}
                      class="${activeLine === index && activeWord === wordIndex
                        ? "caption-part active"
                        : "caption-part"}"
                      >${word.word}</span
                    >`,
                )}
              </div>

              <div class="d-flex gap-1 mt-1 align-items-center">
                <button
                  class="btn btn-sm btn-secondary caption-merge caption-row-more"
                  title="Line actions"
                  aria-haspopup="menu"
                  aria-expanded=${this._menu?.kind === "line" &&
                  this._menu.index === index
                    ? "true"
                    : "false"}
                  @click=${(e: MouseEvent) =>
                    this._toggleMenu(e, "line", index)}
                >
                  <span class="material-symbols-outlined icon-white"
                    >more_vert</span
                  >
                </button>
                <input
                  @input=${(e: Event) => this._handleChangeInput(e, index)}
                  @keydown=${(e: KeyboardEvent) =>
                    this._handleCaptionKeydown(e, index)}
                  class="form-control form-control-sm bg-dark text-light"
                  type="text"
                  id="analyzedEditCaption_${index}"
                  ?disabled=${line.removed === true}
                  .value=${line.text}
                />
              </div>
            </div>`,
        )}
      </div>

      ${this.renderMenu()}
    `;
  }

  /**
   * Whichever menu is open, or nothing.
   *
   * Rendered once, outside the rows and outside the footer, so that the element
   * Lit patches is the same one from open to close: the position is written
   * onto it after it is measured, and a menu that moved in the template on
   * every playhead tick would be measured again on every tick.
   */
  renderMenu() {
    const open = this._menu;
    if (open == null) {
      return nothing;
    }

    const entries =
      open.kind === "placement"
        ? this.renderPlacementEntries()
        : this.renderRowEntries(open.index);
    if (entries == null) {
      return nothing;
    }

    const position = open.position;
    return html`<div
      class="caption-menu"
      role="menu"
      style=${position == null
        ? "visibility:hidden;left:0px;top:0px;"
        : `left:${position.x}px;top:${position.y}px;`}
      @click=${(event: Event) => event.stopPropagation()}
    >
      ${entries}
    </div>`;
  }

  /** Null for a line that is no longer there, which draws no menu at all. */
  private renderRowEntries(index: number) {
    const line = this.lines[index];
    if (line == null) {
      return null;
    }

    return captionRowMenu({ index, removed: line.removed === true }).map(
      (item) =>
        html`<button
          class="caption-menu-item"
          role="menuitem"
          ?disabled=${item.disabled}
          @click=${() => this._runRowMenu(item.action, index)}
        >
          <span class="material-symbols-outlined">${item.icon}</span>
          <span class="caption-menu-label">${item.label}</span>
          ${item.hint == null
            ? nothing
            : html`<span class="caption-menu-hint">${item.hint}</span>`}
        </button>`,
    );
  }

  /**
   * The two placements.
   *
   * The current one is marked with a check, on the right where the line menu
   * puts its keystroke. A glyph rather than a highlight: the entry under the
   * pointer is already highlighted, and two kinds of highlight in one menu say
   * nothing.
   */
  private renderPlacementEntries() {
    return captionPlacementMenu(this._verticalPlacement).map(
      (item) =>
        html`<button
          class="caption-menu-item"
          role="menuitemradio"
          aria-checked=${item.selected ? "true" : "false"}
          @click=${() => this._runPlacementMenu(item.placement)}
        >
          <span class="material-symbols-outlined">${item.icon}</span>
          <span class="caption-menu-label">${item.label}</span>
          ${item.selected
            ? html`<span class="material-symbols-outlined caption-menu-check"
                >check</span
              >`
            : nothing}
        </button>`,
    );
  }

  /**
   * What the edit has already cost, and the two buttons that act on it.
   *
   * The tense changed with the feature. It used to say what Apply *would* do,
   * because nothing had happened yet; the cuts are on the timeline by the time
   * anyone reads this, so it says what is currently removed and the toggle
   * beside it puts it back.
   *
   * There is no Close button. The window's title bar carries the only one, so
   * there is one way out and it cannot get out of step with the other.
   */
  renderFooter() {
    const removedMs = this._silenceOn
      ? this._sourceRanges().reduce(
          (total, cut) => total + Math.max(0, cut.endMs - cut.startMs),
          0,
        )
      : removedSpans(this.lines).reduce(
          (total, cut) => total + Math.max(0, cut.endMs - cut.startMs),
          0,
        );

    // Where the captions sit, as the one glyph the trigger can show. The bar
    // this replaced said it by lighting the selected button.
    const placement = captionPlacementButton(this._verticalPlacement);

    // The toggle is an icon and nothing else, so everything it means has to
    // come out of `caption/silenceButton.ts`, where a test can see it.
    const silence = silenceButtonState({
      available: this._analyzeApi() != null,
      busy: this._silenceBusy,
      gapCount: this._silenceRanges.length,
      silenceOn: this._silenceOn,
      lineCount: this.lines.length,
    });

    return html`
      <div class="caption-panel-footer">
        ${this._silenceError != null
          ? html`<span class="caption-summary text-warning"
              >${this._silenceError}</span
            >`
          : removedMs <= 0
            ? nothing
            : html`<span class="caption-summary text-light">
                ${(removedMs / 1000).toFixed(1)}s cut out.
              </span>`}
        ${silence == null
          ? nothing
          : html`<button
              type="button"
              class="btn btn-sm btn-${silence.variant} caption-icon-btn"
              ?disabled=${silence.disabled}
              title=${silence.label}
              aria-label=${silence.label}
              @click=${() => this.toggleSilence(silence.action === "on")}
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
          class="btn btn-sm btn-secondary caption-icon-btn"
          title=${placement.label}
          aria-label=${placement.label}
          aria-haspopup="menu"
          aria-expanded=${this._menu?.kind === "placement" ? "true" : "false"}
          @click=${(e: MouseEvent) => this._toggleMenu(e, "placement")}
        >
          <span class="material-symbols-outlined icon-white"
            >${placement.icon}</span
          >
        </button>

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
          <td
            class="text-truncate"
            style="max-width: 26rem;"
            title=${row.localpath}
          >
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
