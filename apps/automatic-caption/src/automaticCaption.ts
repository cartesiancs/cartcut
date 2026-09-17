import { LitElement, html, nothing } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import {
  applyLocales,
  localeLabel,
} from "../../app/src/features/caption/locale";
import { type CaptionPlacement } from "../../app/src/features/caption/layout";
import {
  activeAt,
  startsClip,
  type CaptionLine,
} from "../../app/src/features/caption/lines";
import {
  applyLineRemoval,
  applyCaptionEdit,
  captionKeyIntent,
  capturesKey,
  editText,
  flattenCaptionField,
  rejectsCaptionInput,
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
import type {
  CaptionPlayheadPort,
  CaptionSourcePosition,
} from "../../app/src/features/caption/playheadPort";
import { sourceWindowOf } from "../../app/src/features/caption/cuts";
import {
  ChromeGate,
  chromeKeyAt,
  type ChromePosition,
} from "../../app/src/features/caption/previewLoop";
import {
  captionSources,
  sourceDisplayName,
  type CaptionSource,
} from "../../app/src/features/caption/sources";
import {
  clipFollows,
  clipRanges,
  clipSections,
  joinClipLines,
  removedTotalOf,
  sweepClips,
  transcribeClips,
  type ClipJob,
  type ClipRanges,
} from "../../app/src/features/caption/clips";
import {
  initialPick,
  pickedSources,
  reconcilePick,
  type ClipPick,
} from "../../app/src/features/caption/clipPick";
import type { TimeRange } from "../../app/src/features/timeline/clipOps";
import { TranscribeSession } from "../../app/src/features/caption/transcribeSession";
import "./progress";
import "./clipPicker";

/** One chosen clip, as the panel keeps it for the length of a run. */
type PanelClip = ClipJob & { name: string; filetype: "video" | "audio" };

@customElement("automatic-caption")
export class AutomaticCaption extends LitElement {
  isLoadVideo: boolean;

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
   * The silences the sweep found, in source ms, by clip.
   *
   * Kept whole and kept for the whole session, because the toggle needs them
   * back. Turning the cuts off does not put a cut back, which has no inverse:
   * it sends shorter lists of ranges and the session rebuilds from its
   * baseline. So these lists are the thing that has to survive, not the cuts.
   */
  private _silenceByKey: Record<string, TimeRange[]> = {};

  /** Whether those gaps are currently cut out of the timeline. */
  private _silenceOn = true;

  /** A decode is running. One ffmpeg pass, so a spinner rather than a bar. */
  private _silenceBusy = false;

  /** Why a clip's sweep found nothing, by clip, shown rather than swallowed. */
  private _silenceErrors: Record<string, string> = {};

  /**
   * The clips being captioned, in the order the user chose, each with its
   * window into its source file as it was when the last transcript landed.
   *
   * Held rather than looked up, and that is the same rule `applyCaptions.ts`
   * states: the session cuts the clips within a second of the windows being
   * read, and `removeRanges` does not always leave the original id behind.
   * Asking `this.timeline[key]` afterwards gets `undefined` for an entirely
   * ordinary case, and `wordGaps` would then be bounded by nothing.
   */
  private _clips: PanelClip[] = [];

  /**
   * The picker's choice: element keys, in order. Kept after a run, so reopening
   * the picker after a failure or a cancel does not mean choosing again.
   */
  private _pick: ClipPick = [];
  private _pickerOpen = false;
  /** The rows the picker was opened on. */
  private _pickerRows: CaptionSource[] = [];

  /** Which of the chosen clips is being transcribed, for the progress screen. */
  private _transcribing: { index: number; total: number; name: string } | null =
    null;

  /**
   * Which run is current. A cancel, a close and a new run each move it on, so a
   * run still awaiting its transcript can tell that nobody is waiting for it
   * any more and stop instead of starting its next clip.
   */
  private _runId = 0;

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

  /**
   * Every chosen clip under the playhead, and where in its file. Fed by the
   * `playhead` port. Empty between clips; two entries where two chosen clips
   * play at once on two tracks.
   */
  private _positions: CaptionSourcePosition[] = [];

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
    this.lines = [];
    this._undo = [];

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
    // left behind accumulates once per open. The clip picker gives back its own
    // listener and frame cache when it is removed with the panel.
    //
    // A transcription nobody is waiting for. `requestCancel` is a no-op with no
    // job in flight, so this needs no guard of its own; moving the run on stops
    // the clips after it from starting.
    this._runId += 1;
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
   * The timeline's selection, read once when the clip picker opens, so clips
   * selected on the timeline arrive already chosen. A function, from
   * `Control`, for the reason the playhead is a port: the panel cannot read
   * the store.
   */
  @property({ attribute: false })
  timelineSelection: (() => readonly string[]) | null = null;

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
      this._positions = port.sourcePositions();
      this._syncChrome();
    });
    this._positions = port.sourcePositions();
  }

  private _syncChrome(): void {
    // Gated on what the template actually shows: which line and word are lit,
    // for every clip under the playhead. The duration readout that once shared
    // this gate went with the preview column, so its half is always empty.
    if (this._chrome.changed(this._activeKey(), "")) {
      this.requestUpdate();
    }
  }

  /**
   * The positions a line is matched against.
   *
   * A line list nobody tagged (one clip, seeded by hand) is matched by the
   * first position alone and without a key, which is how it was matched
   * before clips had keys at all.
   */
  private _matchPositions(): ChromePosition[] {
    if (this.lines.some((line) => line.sourceKey != null)) {
      return this._positions;
    }
    return this._positions
      .slice(0, 1)
      .map((position) => ({ seconds: position.seconds }));
  }

  /** The lit line and word for every clip under the playhead, as one key. */
  private _activeKey(): string {
    return chromeKeyAt(this.lines, this._matchPositions());
  }

  /** Line index to lit word index, for every clip under the playhead. */
  private _activeLines(): Map<number, number | null> {
    const lit = new Map<number, number | null>();
    for (const position of this._matchPositions()) {
      const { lineIndex, wordIndex } = activeAt(
        this.lines,
        position.seconds,
        position.key,
      );
      if (lineIndex != null) {
        lit.set(lineIndex, wordIndex);
      }
    }
    return lit;
  }

  // -------------------------------------------------------- the clip picker

  /**
   * Open the picker on the clips the timeline holds now.
   *
   * Rows are keyed by element, not by path: two clips cut from one file share
   * a `localpath`, and comparing on that selected both and transcribed
   * whichever came first.
   */
  openPicker() {
    const rows = captionSources(this.timeline);
    this._pickerRows = rows;
    this._pick = initialPick({
      previous: this._pick,
      timelineSelection: this.timelineSelection?.() ?? [],
      rows,
    });
    this._pickerOpen = true;
    this.requestUpdate();
  }

  // Arrow properties, like every handler handed to another element's events.
  private readonly _onPickChange = (event: CustomEvent<{ pick: ClipPick }>) => {
    this._pick = event.detail.pick;
    this.requestUpdate();
  };

  private readonly _onPickClose = () => {
    this._pickerOpen = false;
    this.requestUpdate();
  };

  private readonly _onPickStart = (event: CustomEvent<{ pick: ClipPick }>) => {
    this._pick = event.detail.pick;
    this._pickerOpen = false;
    // The picker closes whether or not the run gets as far as a repaint.
    this.requestUpdate();
    void this.startChosenClips();
  };

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
   * Transcribe the chosen clips, one after another, in the chosen order.
   *
   * One call into main per clip, which extracts the audio and runs the
   * recogniser. The panel used to do the first half itself through the legacy
   * fluent-ffmpeg IPC and the second half with `axios`, against a server the
   * user had to run and whose URL lived in a DOM input. Both halves are gone:
   * main's `transcribeFile` is the same function the MCP `get_transcript` tool
   * calls, so the two share one disk cache and a clip the agent has already
   * read opens instantly here. Two clips cut from one file share it too.
   */
  async transcribeChosenClips() {
    const session = this._session;
    if (session == null) {
      this._failAnalysis("Transcription needs the desktop app.");
      return;
    }

    const run = ++this._runId;
    const stale = () => run !== this._runId;
    const clips = this._clips;

    const outcome = await transcribeClips(clips, {
      cancelled: stale,
      run: (clip, index, total) => {
        this._transcribing = {
          index,
          total,
          name: clips.find((c) => c.key === clip.key)?.name ?? "",
        };
        return session.run(
          {
            source: clip.localpath,
            method: this.sttMethod,
            // The session withholds this for OpenAI, which detects the language.
            locale: this.selectedLocale,
          },
          () => this.requestUpdate(),
        );
      },
    });

    // A cancel, a close or a newer run has taken over. Whatever this run
    // would write now belongs to nobody.
    if (stale()) {
      return;
    }
    this._transcribing = null;

    if (outcome.kind === "cancelled") {
      this._endAnalysis();
      return;
    }
    if (outcome.kind === "failed") {
      const clip = clips.find((c) => c.key === outcome.key);
      this._failAnalysis(
        clips.length > 1 && clip != null
          ? `${clip.name}: ${outcome.message}`
          : outcome.message,
      );
      return;
    }

    // Every window is read now, after the last transcript and before anything
    // cuts. The timeline stays editable while the clips are transcribed, which
    // can take minutes, and a window read before the first clip could be stale
    // by the last.
    this._clips = clips.map((clip) => ({
      ...clip,
      window: sourceWindowOf(this.timeline?.[clip.key]) ?? null,
    }));
    this.lines = joinClipLines(outcome.byKey, this._clips, uuidv4);
    this._undo = [];

    // The sweep used to be a button the user pressed, and pressing it was the
    // only way to find out whether there was anything to cut. It is part of the
    // same run now: one press gets a transcript, the silences gone and the
    // words on the timeline, which is the whole gesture anybody wanted.
    await this.sweepSilence();
    if (stale()) {
      return;
    }

    this._startSession();
  }

  /**
   * Find the silences worth cutting, clip by clip.
   *
   * Both halves must agree: the signal (an absolute dBFS threshold over an RMS
   * envelope, from `analyze:silences`) and the **words**, each clip's own. The
   * signal alone cuts a word quiet enough to dip under the threshold and keeps
   * laughter; the words alone call every wordless gap dead air, sting included.
   *
   * `analyzeSilences` is cached on disk by file identity and deduped while it
   * runs, so this is one ffmpeg decode per file the first time and nothing
   * after. A failure leaves that clip's list empty and the reason on the
   * footer: there is still a transcript to place, so it is a part of the run
   * that can fail on its own.
   */
  private async sweepSilence(): Promise<void> {
    const api = this._analyzeApi();
    if (api == null) {
      return;
    }

    this._silenceBusy = true;
    this.phase = "sweeping";
    this.requestUpdate();

    try {
      const swept = await sweepClips(this._clips, this.lines, (localpath) =>
        api.silences({ source: localpath }),
      );
      this._silenceByKey = swept.byKey;
      this._silenceErrors = swept.errors;
    } finally {
      this._silenceBusy = false;
      this.requestUpdate();
    }
  }

  /** The footer's warning, or null. Names the clip when there are several. */
  private _silenceErrorText(): string | null {
    const failed = Object.entries(this._silenceErrors);
    if (failed.length === 0) {
      return null;
    }
    const [key, message] = failed[0];
    if (this._clips.length <= 1) {
      return message;
    }
    const name = this._clips.find((clip) => clip.key === key)?.name ?? key;
    const more = failed.length > 1 ? ` (+${failed.length - 1})` : "";
    return `${name}: ${message}${more}`;
  }

  /** How many gaps the sweep found, across the clips that were swept. */
  private _silenceGapCount(): number {
    return Object.values(this._silenceByKey).reduce(
      (total, ranges) => total + ranges.length,
      0,
    );
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
          clips: this._clipRanges(),
          placement: this._verticalPlacement,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Every range the session should cut, in source ms, clip by clip.
   *
   * Two gestures, one list per clip, and they are the same thing by the time
   * they get here: a struck-out caption line contributes its own span, and the
   * sweep contributes what the signal and the words agreed on. The toggle
   * decides only whether the second half is included. A twin takes both from
   * the clip it follows (`clips.ts`).
   */
  private _clipRanges(): ClipRanges[] {
    return clipRanges(
      this.lines,
      this._clips,
      this._silenceByKey,
      this._silenceOn,
    );
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
          ranges: this._clipRanges(),
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
    this._silenceByKey = {};
    this._silenceErrors = {};
    this._clips = [];
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
    this._transcribing = null;
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
    this._transcribing = null;
    this._failMessage = message;
    this.phase = "failed";
    this.applyCursorEvent("pointer");
    this.requestUpdate();
  }

  cancelAnalysis() {
    // Moving the run on stops the clips after this one from starting:
    // `requestCancel` reaches only the job that is running, and between two
    // jobs there is none.
    this._runId += 1;
    // Reads the live job id, so it has to run *before* `_endAnalysis` clears it.
    // Reversed, main is sent nothing and silently ignores it, and Cancel appears
    // to work while the job runs on.
    this._session?.requestCancel();
    this._endAnalysis();
  }

  /**
   * Start on the chosen clips.
   *
   * The choice is checked against the timeline as it is now, because the
   * timeline stays editable while the picker is open.
   */
  async startChosenClips() {
    // No `lockKeyboard` here any more. The lock follows the caret instead, in
    // `_handlePanelFocusIn`, because the editor no longer covers the app.
    const rows = captionSources(this.timeline);
    this._pick = reconcilePick(this._pick, rows);
    const picked = pickedSources(this._pick, rows);
    if (picked.length === 0) {
      this.requestUpdate();
      return;
    }

    // Each clip carries its own path. The path used to be re-derived from the
    // field that identifies the row, which was the path once and is the
    // element key now, so this handed a key to ffmpeg and every transcription
    // failed with "No such media file". One name for one value.
    const follows = clipFollows(picked);
    this._clips = picked.map((row) => ({
      key: row.key,
      localpath: row.localpath,
      name: sourceDisplayName(row.localpath),
      filetype: row.filetype,
      window: null,
      ...(follows.has(row.key) ? { follows: follows.get(row.key) } : {}),
    }));
    this.isLoadVideo = true;

    // One path for video and audio alike: main runs ffmpeg over whatever it is
    // handed.
    //
    // The progress used to be a Bootstrap dialog opened here, behind a 180ms
    // gate so a cached transcript would not flash one. There is no gate any
    // more and none is needed: the run does not end with the transcript, it
    // goes on into the sweep and the reveal, so there is no instant path to
    // flicker.
    this.phase = "transcribing";
    this.requestUpdate();

    await this.transcribeChosenClips();
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
  clickCaptionText(key: string, timeSec: number) {
    this.playhead?.seekToSource(key, timeSec);
  }

  /** The clip a line belongs to. An untagged line belongs to the first. */
  private _keyOfLine(line: CaptionLine): string {
    return line.sourceKey ?? this._clips[0]?.key ?? "";
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
    if (this._silenceOn === on || this._silenceGapCount() === 0) {
      return;
    }
    this._silenceOn = on;
    this._emitChange();
    this.requestUpdate();
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
      const field = this.querySelector<HTMLTextAreaElement>(
        `#analyzedEditCaption_${index}`,
      );
      if (field == null) {
        return;
      }
      field.focus();
      const at = Math.min(caretOffset, field.value.length);
      field.setSelectionRange(at, at);
    });
  }

  /**
   * A keystroke in a caption's field.
   *
   * The whole matrix (the IME guard, Enter, Backspace, Delete, Cmd+Z) is
   * `caption/editor.ts#captionKeyIntent`, and `capturesKey` decides whether the
   * keystroke is cancelled. This is a dispatcher over plain numbers, which is
   * what makes the matrix testable without a DOM.
   */
  _handleCaptionKeydown(event: KeyboardEvent, index: number) {
    const field = event.target as HTMLTextAreaElement;
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
        selectionStart: field.selectionStart,
        selectionEnd: field.selectionEnd,
        valueLength: field.value.length,
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

  /** Stops the line break an Enter the IME guard let through would type. */
  _handleCaptionBeforeInput(event: InputEvent) {
    if (rejectsCaptionInput(event.inputType)) {
      event.preventDefault();
    }
  }

  _handleChangeInput(event: Event, index: number) {
    const field = event.target as HTMLTextAreaElement;
    const typed = {
      value: field.value,
      selectionStart: field.selectionStart,
      selectionEnd: field.selectionEnd,
    };
    const flat = flattenCaptionField(typed);
    if (flat !== typed) {
      // Into the field before the state. Lit compares `.value` with what it
      // last committed, not with the field, so a state the field disagreed with
      // would be written back and throw the caret to the end.
      field.value = flat.value;
      field.setSelectionRange(
        flat.selectionStart ?? flat.value.length,
        flat.selectionEnd ?? flat.value.length,
      );
    }

    // Straight to state, no snapshot: typing is the field's own undo to manage.
    const next = editText(this._editorState(), index, flat.value).lines;
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
        .caption-cut .caption-text {
          text-decoration: line-through;
          opacity: 0.45;
        }

        /* One caption, wrapped instead of scrolled sideways, and as tall as its
           text. field-sizing needs Chromium 123 and Electron 33 ships 130. At
           one line it is the old input's height, because Bootstrap gives
           textarea.form-control-sm the min-height .form-control-sm has.
           A zero basis and min-width keep a long unbroken word from widening
           the row past the panel. Bootstrap sets textarea resize: vertical,
           and a drag handle would fight the content for the height. */
        .caption-text {
          field-sizing: content;
          flex: 1 1 0;
          min-width: 0;
          resize: none;
          overflow: hidden;
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

        /* The line menu trigger is an outline and nothing else, in the border
           colour the fields and panel dividers use. Qualified with .btn because
           devent-designsystem.css sets .btn border-color to transparent, which
           is also why btn-outline-secondary draws no outline in this app. Hover
           and an open menu brighten the line rather than filling the box. */
        .btn.caption-row-more {
          background-color: transparent;
          border-color: #3a3f44;
        }

        .btn.caption-row-more:hover,
        .btn.caption-row-more[aria-expanded="true"] {
          background-color: transparent;
          border-color: #6c757d;
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

        .caption-clips-btn {
          display: inline-flex !important;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
        }

        .caption-clips-btn.d-none {
          display: none !important;
        }

        .caption-clips-btn .material-symbols-outlined {
          font-size: 1.15rem;
        }

        .caption-clips-count {
          min-width: 1.2rem;
          height: 1.2rem;
          padding: 0 0.3rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: #3838d3;
          font-size: 0.7rem;
          font-weight: 700;
        }

        /* A clip's header in the caption list, when there is more than one.
           A button, because it seeks to the clip's first frame. */
        .caption-section {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          width: 100%;
          margin-top: 0.4rem;
          padding: 0.2rem 0.1rem;
          border: none;
          border-bottom: 1px solid #26262b;
          background: transparent;
          color: #d8d8de;
          font-size: 0.8rem;
          text-align: left;
          cursor: pointer;
        }

        .caption-section:first-child {
          margin-top: 0;
        }

        .caption-section:hover {
          color: #ffffff;
        }

        .caption-section .material-symbols-outlined {
          font-size: 1rem;
          color: #8a8a94;
        }

        .caption-section-number {
          min-width: 1.2rem;
          height: 1.2rem;
          padding: 0 0.3rem;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          background: #3838d3;
          color: #ffffff;
          font-size: 0.7rem;
          font-weight: 700;
        }

        .caption-section-name {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .caption-phase-clip {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.4rem;
          font-size: 0.8rem;
          color: #d8d8de;
          min-width: 0;
        }

        .caption-phase-counter {
          flex: 0 0 auto;
          padding: 0.05rem 0.45rem;
          border-radius: 999px;
          background: #26262b;
          font-variant-numeric: tabular-nums;
        }

        .caption-phase-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
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

      <caption-clip-picker
        .rows=${this._pickerRows}
        .pick=${this._pick}
        ?open=${this._pickerOpen}
        @clipPickChange=${this._onPickChange}
        @clipPickClose=${this._onPickClose}
        @clipPickStart=${this._onPickStart}
      ></caption-clip-picker>
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
      clip: this._transcribing ?? undefined,
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
        ${view.counter != null && this._transcribing != null
          ? html`<span class="caption-phase-clip">
              <span class="caption-phase-counter">${view.counter}</span>
              <span class="caption-phase-name">${this._transcribing.name}</span>
            </span>`
          : nothing}
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
        class="btn btn-sm btn-default text-light mt-1 caption-clips-btn ${this
          .isLoadVideo
          ? "d-none"
          : ""}"
        @click=${() => this.openPicker()}
      >
        <span class="material-symbols-outlined icon-white" aria-hidden="true"
          >video_library</span
        >
        <span>Clips</span>
        ${this._pick.length > 0
          ? html`<span class="caption-clips-count">${this._pick.length}</span>`
          : nothing}
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
    // The same answer `_syncChrome` gates on, from the same function: these
    // were two independent copies of the same three lines.
    const lit = this._activeLines();

    // A header before each clip's lines, once there is more than one clip. A
    // clip with no speech still gets its header, at the place its lines would
    // have been, so nothing chosen goes missing without a word.
    const leaders = this._clips.filter((clip) => clip.follows == null);
    const headers = new Map<number, typeof leaders>();
    if (leaders.length > 1) {
      const sections = clipSections(
        this.lines,
        leaders.map((clip) => clip.key),
      );
      sections.forEach((section, order) => {
        const list = headers.get(section.from) ?? [];
        list.push(leaders[order]);
        headers.set(section.from, list);
      });
    }
    const headersAt = (index: number) =>
      (headers.get(index) ?? []).map((clip) =>
        this.renderSection(clip, leaders.indexOf(clip) + 1, index),
      );

    return html`
      <div class="caption-editor-lines">
        ${this.lines.map(
          (line, index) =>
            html`${headersAt(index)}<div
              class="text-light caption ${line.removed === true
                ? "caption-cut"
                : ""}"
            >
              <div class="caption-ribbon">
                ${line.words.map(
                  (word, wordIndex) =>
                    html`<span
                      @click=${() =>
                        this.clickCaptionText(this._keyOfLine(line), word.start)}
                      class="${lit.has(index) && lit.get(index) === wordIndex
                        ? "caption-part active"
                        : "caption-part"}"
                      >${word.word}</span
                    >`,
                )}
              </div>

              <div class="d-flex gap-1 mt-1 align-items-start">
                <button
                  class="btn btn-sm caption-merge caption-row-more"
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
                <textarea
                  @beforeinput=${(e: InputEvent) =>
                    this._handleCaptionBeforeInput(e)}
                  @input=${(e: Event) => this._handleChangeInput(e, index)}
                  @keydown=${(e: KeyboardEvent) =>
                    this._handleCaptionKeydown(e, index)}
                  class="form-control form-control-sm bg-dark text-light caption-text"
                  rows="1"
                  id="analyzedEditCaption_${index}"
                  ?disabled=${line.removed === true}
                  .value=${line.text}
                ></textarea>
              </div>
            </div>`,
        )}
        ${headersAt(this.lines.length)}
      </div>

      ${this.renderMenu()}
    `;
  }

  /**
   * One clip's header in the caption list: its number, its kind and its name.
   * Clicking it puts the playhead at the clip's first frame.
   */
  renderSection(clip: PanelClip, number: number, at: number) {
    const empty = this.lines[at]?.sourceKey !== clip.key;
    const twinned = this._clips.some((other) => other.follows === clip.key);
    return html`<button
      type="button"
      class="caption-section"
      title=${clip.name}
      @click=${() =>
        this.clickCaptionText(clip.key, (clip.window?.startMs ?? 0) / 1000)}
    >
      <span class="caption-section-number">${number}</span>
      <span class="material-symbols-outlined" aria-hidden="true"
        >${clip.filetype === "audio" ? "graphic_eq" : "movie"}</span
      >
      ${twinned
        ? html`<span class="material-symbols-outlined" aria-hidden="true"
            >link</span
          >`
        : nothing}
      <span class="caption-section-name">${clip.name}</span>
      ${empty
        ? html`<span
            class="material-symbols-outlined caption-section-quiet"
            title="No speech"
            aria-label="No speech"
            >voice_over_off</span
          >`
        : nothing}
    </button>`;
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

    return captionRowMenu({
      index,
      removed: line.removed === true,
      startsClip: startsClip(this.lines, index),
    }).map(
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
    // A twin is cut exactly as the clip it follows, so it is left out of the
    // sum rather than counted twice.
    const followers = new Set(
      this._clips.filter((clip) => clip.follows != null).map((clip) => clip.key),
    );
    const removedMs = removedTotalOf(
      this._clipRanges().filter((ranges) => !followers.has(ranges.key)),
    );
    const silenceError = this._silenceErrorText();

    // Where the captions sit, as the one glyph the trigger can show. The bar
    // this replaced said it by lighting the selected button.
    const placement = captionPlacementButton(this._verticalPlacement);

    // The toggle is an icon and nothing else, so everything it means has to
    // come out of `caption/silenceButton.ts`, where a test can see it.
    const silence = silenceButtonState({
      available: this._analyzeApi() != null,
      busy: this._silenceBusy,
      gapCount: this._silenceGapCount(),
      silenceOn: this._silenceOn,
      lineCount: this.lines.length,
      clipCount: this._clips.length - followers.size,
    });

    return html`
      <div class="caption-panel-footer">
        ${silenceError != null
          ? html`<span class="caption-summary text-warning"
              >${silenceError}</span
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
}
