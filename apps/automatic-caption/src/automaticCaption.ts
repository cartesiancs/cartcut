import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import {
  applyLocales,
  localeLabel,
} from "../../app/src/features/caption/locale";
import { type CaptionPlacement } from "../../app/src/features/caption/layout";
import {
  activeAt,
  type CaptionLine,
} from "../../app/src/features/caption/lines";
import {
  applyCaptionEdit,
  captionKeyIntent,
  capturesKey,
  editText,
  type CaptionEditor,
  type CaptionKeyIntent,
} from "../../app/src/features/caption/editor";
import { captionRows } from "../../app/src/features/caption/rows";
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
  panelVideoModal: any;
  isPlay: boolean;
  /** The two animation-frame handles. See `caption/previewLoop.ts`. */
  private readonly _loop = new PreviewLoop(windowScheduler());
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
    this.analyzingVideoModal?.dispose();
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

    // Close the progress dialog, *then* show the editor — two Bootstrap modals
    // transitioning in one tick over shared `body.modal-open` state, which is
    // the family of bug `TransientModal` exists for. Do not reorder, and do not
    // await `updateComplete` in between: the first paint is deferred to the
    // panel's own `shown.bs.modal`.
    this.analyzingVideoModal?.close();
    this.requestUpdate();
    this.panelVideoModal.show();
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
    this.applyCursorEvent("lockKeyboard");

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
    this.applyCursorEvent("pointer");
    this._stopLoop();
    this.mediaElement()?.pause();
    this.analyzingVideoModal?.close();

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

    this.dispatchEvent(
      new CustomEvent("editComplate", {
        detail: { result },
        bubbles: true,
        composed: true,
      }),
    );

    this.isLoadVideo = false;
    this.requestUpdate();
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

      const panel = document.getElementById("VideoPanel");
      this.panelVideoModal = new bootstrap.Modal(panel, {
        keyboard: false,
      });

      // The canvas has no layout box until the modal is shown, and nothing
      // painted on open before — the preview stayed blank until the user
      // pressed play, reset, or clicked a word.
      panel?.addEventListener("shown.bs.modal", () => {
        void fontsSettled().then(() => this.schedulePaint());
      });
      panel?.addEventListener("hidden.bs.modal", () => {
        this.mediaElement()?.pause();
        this._stopLoop();
        this.isPlay = false;
      });

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
    // The same pair `syncChrome` gates on, from the same function — these were
    // two independent copies of the same three lines.
    const { lineIndex: activeLine, wordIndex: activeWord } = activeAt(
      this.lines,
      this.progress,
    );

    const analyzedTextMap = this.lines.map(
      (line, index) => html`<div class="text-light caption">
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
            ?disabled=${index === 0}
            title="Merge into the line above (Backspace at the start of the line)"
            @click=${() => this.mergeLine(index)}
          >
            <span class="material-symbols-outlined icon-white">merge</span>
          </button>
          <input
            @input=${(e: Event) => this._handleChangeInput(e, index)}
            @keydown=${(e: KeyboardEvent) =>
              this._handleCaptionKeydown(e, index)}
            class="form-control bg-dark text-light"
            type="text"
            id="analyzedEditCaption_${index}"
            .value=${line.text}
          />
        </div>
      </div>`,
    );

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
      </style>
      <div
        class="d-flex"
        style="flex-direction: column;
    padding: 1rem;     justify-content: center;
    align-items: center;
    gap: 1rem;"
      >
        <div class="d-flex gap-2 col">
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

      <div
        class="modal fade"
        id="VideoPanel"
        data-bs-keyboard="false"
        data-bs-backdrop="static"
        tabindex="-1"
      >
        <div class="modal-dialog modal-dialog-dark modal-fullscreen">
          <div class="modal-content modal-dark modal-darker">
            <div class="modal-body">
              <div class="d-flex gap-3 mt-4 align-items-start">
                <div
                  class="d-flex flex-column gap-2 caption-preview-column"
                  style="position: sticky; top: 0; align-self: flex-start; flex: 0 0 42%; min-width: 0;"
                >
                  <canvas
                    id="previewCanvasCaption"
                    width=${this.previewSize.w}
                    height=${this.previewSize.h}
                    style="display: block; max-width: 100%; max-height: 55vh; width: auto; height: auto; background: #000;"
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
                    percent="${playbackFraction(
                      this.progress,
                      this.durationSec(),
                    ) * 100}"
                  ></progress-bar>

                  <div class="d-flex col gap-2">
                    <button
                      class=" btn btn-sm btn-secondary"
                      @click=${this.resetVideo}
                    >
                      <span
                        class="material-symbols-outlined icon-white icon-md"
                      >
                        restart_alt
                      </span>
                    </button>
                    <button
                      class="${this.isPlay
                        ? "d-none"
                        : ""} btn btn-sm btn-secondary"
                      @click=${this.playVideo}
                    >
                      <span
                        class="material-symbols-outlined icon-white icon-md"
                      >
                        play_circle
                      </span>
                    </button>

                    <button
                      class="${!this.isPlay
                        ? "d-none"
                        : ""}  btn btn-sm btn-danger"
                      @click=${this.stopVideo}
                    >
                      <span
                        class="material-symbols-outlined icon-white icon-md"
                      >
                        stop_circle
                      </span>
                    </button>
                  </div>
                  <div class="d-flex col gap-2">
                    <button
                      class="btn btn-sm ${this._verticalPlacement == "center"
                        ? "btn-primary"
                        : "btn-secondary"}"
                      @click=${() =>
                        this.handleClickAlignCaptionButton("center")}
                    >
                      align center
                    </button>
                    <button
                      class="btn btn-sm ${this._verticalPlacement == "lowerThird"
                        ? "btn-primary"
                        : "btn-secondary"}"
                      @click=${() =>
                        this.handleClickAlignCaptionButton("lowerThird")}
                    >
                      align bottom
                    </button>
                  </div>

                </div>

                <div style="flex: 1 1 0; min-width: 0;">
                  <div class="d-flex flex-column gap-2">${analyzedTextMap}</div>
                </div>
              </div>
            </div>
            <div class="modal-footer modal-footer-dark ">
              <div class="flex row gap-2">
                <button
                  type="button"
                  class="col btn btn-sm btn-secondary btn-nowarp"
                  data-bs-dismiss="modal"
                  @click=${() => {
                    this.isLoadVideo = false;
                    this.analyzingVideoModal?.close();
                    this.requestUpdate();
                  }}
                >
                  Close
                </button>
                <button
                  type="button"
                  class="col btn btn-sm btn-primary btn-nowarp"
                  data-bs-dismiss="modal"
                  @click=${this.handleClickComplate}
                >
                  Complate Edit
                </button>
              </div>
            </div>
          </div>
        </div>
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
