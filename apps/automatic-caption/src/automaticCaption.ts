import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import {
  chooseDefaultLocale,
  sortLocales,
} from "../../app/src/features/caption/locale";
import {
  captionLayout,
  type CaptionPlacement,
} from "../../app/src/features/caption/layout";
import {
  captionsFrom,
  lineIndexAt,
  linesFromWordGroups,
  mergeCaretOffset,
  mergeLineWithPrevious,
  setLineText,
  splitLineAt,
  wordIndexAt,
  type CaptionLine,
} from "../../app/src/features/caption/lines";
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
import { createTextElement } from "../../app/src/features/element/textElement";
import { fontsSettled } from "../../app/src/features/element/rasterizeText";
import { renderElement } from "../../app/src/features/renderer/element";
import { renderText } from "../../app/src/features/renderer/text";
import { TransientModal } from "../../app/src/features/ui/transientModal";
import "./progress";

/** How many split/merge steps the panel's own Cmd+Z can walk back. */
const UNDO_LIMIT = 50;

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
  private _done: boolean;
  private _animationFrameId: any;
  private _paintRequest: number;
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
  private _shownActive = "";
  private _shownLabel = "";

  /** Languages this Mac can transcribe, and whether it can at all. */
  locales: { id: string; name: string; installed: boolean }[];
  selectedLocale: string;
  speechAvailable: boolean;
  speechReason: string;

  /** The running job. Minted here so a model download can be cancelled. */
  jobId: string | null;
  progressFraction: number;
  progressStage: string;
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

    this._done = false;
    this._animationFrameId = null;
    this._paintRequest = 0;

    this.locales = [];
    this.selectedLocale = "";
    this.speechAvailable = false;
    this.speechReason = "";

    this.jobId = null;
    this.progressFraction = 0;
    this.progressStage = "";
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
      this._unsubscribeProgress = api.onProgress((payload: any) => {
        // Progress for a job we are no longer waiting on is not ours to draw.
        if (payload?.jobId !== this.jobId) {
          return;
        }
        this.progressFraction = payload.fraction ?? 0;
        this.progressStage = payload.stage ?? "";
        this.requestUpdate();
      });

      api.locales().then((result: any) => {
        this.speechAvailable = result?.available === true;
        this.speechReason = result?.reason ?? "";
        this.locales = sortLocales(result?.locales ?? []);
        this.selectedLocale = this._defaultLocale();
        // Falling back silently would transcribe with OpenAI while the button
        // still said On-device.
        if (!this.speechAvailable) {
          this.sttMethod = "openai";
        }
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
    this._done = true;
    if (this._animationFrameId) {
      window.cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }
    if (this._paintRequest) {
      window.cancelAnimationFrame(this._paintRequest);
      this._paintRequest = 0;
    }
  }

  private _transcribeApi(): any {
    // Null in the web build, which has no main process behind the bridge.
    return (window as any).electronAPI?.req?.transcribe ?? null;
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
  private _defaultLocale(): string {
    const preferences = [
      ...(navigator.languages ?? []),
      navigator.language ?? "",
    ];
    return chooseDefaultLocale(this.locales, preferences);
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
   * One caption's options, and the single source of what a caption *is*.
   *
   * `redrawPreview` turns these into an element to draw; `handleClickComplate`
   * emits them, and `Control` → `elementControl.addText` hands them to the same
   * `createTextElement`. The preview and the placed element therefore cannot
   * differ in anything that reaches the picture — which is the whole point, and
   * what the hand-rolled `drawCaption` could never promise. It was out by a
   * font size vertically, used a line advance of 52 against the renderer's 62.4,
   * and padded the background band on one side only.
   */
  private captionOptions(index: number) {
    const line = this.lines[index];
    const layout = captionLayout(this.previewSize, this._verticalPlacement);

    return {
      ...layout,
      text: line?.text ?? "",
      textcolor: "#ffffff",
      optionsAlign: "center" as const,
      backgroundEnable: true,
    };
  }

  private captionElement(index: number) {
    return createTextElement(this.captionOptions(index));
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

    // Fill rather than clear, with the project's own background — what
    // `renderer/timeline.ts#paint` does before drawing anything. There was no
    // clear of any kind here before, so an audio-only clip stacked every caption
    // it had ever drawn on top of the last.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = this.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    this.drawSourceFrame(ctx);

    const index = lineIndexAt(this.lines, this.progress);
    if (index != null) {
      // The real path: `renderTimelineAtTime` → `paint` → `renderElement` →
      // `renderText`. `context` is omitted deliberately — it is only read for
      // parent lookups, and a caption that is not on the timeline yet has no
      // parent. The cursor is inert for a plain caption (every animation track
      // is inactive and there is no reveal), but it is passed honestly anyway.
      renderElement(
        ctx,
        "caption-preview",
        this.captionElement(index),
        this.progress * 1000,
        false,
        renderText,
      );
    }
  }

  /**
   * The clip's own picture, in the clip's own box.
   *
   * Drawn at the frame's size rather than the canvas's: a 4K clip in a 1080p
   * project overflows here exactly as it will on the timeline, instead of being
   * silently squashed to fit, which is information the user needs while
   * positioning captions over it.
   */
  private drawSourceFrame(ctx: CanvasRenderingContext2D): void {
    if (this.mediaType !== "video") {
      return;
    }
    const video = this.mediaElement() as HTMLVideoElement | null;
    if (video == null || video.readyState < 2) {
      return;
    }
    ctx.drawImage(video, 0, 0, this.previewSize.w, this.previewSize.h);
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
    if (this._paintRequest) {
      return;
    }
    this._paintRequest = window.requestAnimationFrame(() => {
      this._paintRequest = 0;
      this.redrawPreview();
    });
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
    const api = this._transcribeApi();
    if (api == null) {
      this._failAnalysis("Transcription needs the desktop app.");
      return;
    }

    // Minted before the call so Cancel works during a first-run model download,
    // which is the long wait and resolves `start` only when it finishes.
    this.jobId = uuidv4();
    this.progressFraction = 0;
    this.progressStage = "extracting";
    this.requestUpdate();

    let result: any;
    try {
      result = await api.start(this.jobId, {
        source: this.videoPath,
        method: this.sttMethod,
        locale: this.sttMethod === "apple" ? this.selectedLocale : undefined,
      });
    } catch (error) {
      this._failAnalysis(String(error));
      return;
    } finally {
      this.jobId = null;
    }

    if (result?.ok !== true) {
      if (result?.cancelled === true) {
        this._endAnalysis();
        return;
      }
      this._failAnalysis(result?.error ?? "Transcription failed.");
      return;
    }

    // Main groups the words into caption lines with `analysis/segments.ts`,
    // which is where the rule for where a caption breaks lives and is tested.
    // Only the units change here: ms to seconds, and `confidence` to `score`.
    this.lines = linesFromWordGroups(
      (result.lines ?? []).map((line: any[]) =>
        line.map((word: any) => ({
          word: word.word,
          start: word.startMs / 1000,
          end: word.endMs / 1000,
          ...(word.confidence != null ? { score: word.confidence } : {}),
        })),
      ),
    );
    this._undo = [];

    this.analyzingVideoModal?.close();
    this.requestUpdate();
    this.panelVideoModal.show();
  }

  /** Give the keyboard back and close the progress modal. */
  _endAnalysis() {
    this.analyzingVideoModal?.close();
    this.isLoadVideo = false;
    this.jobId = null;
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
    const api = this._transcribeApi();
    if (api != null && this.jobId != null) {
      void api.cancel(this.jobId);
    }
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

    // `captionsFrom` drops a line the user emptied and guarantees a positive
    // duration; `captionOptions` is the same factory the preview drew with, so
    // what is placed is what was on screen.
    const result = captionsFrom(this.lines).map((caption, index) => ({
      // The clip that was transcribed. `startTime`/`duration` are in that
      // file's own time, since that is what a transcript timestamps; the app
      // converts them to timeline time before placing the captions.
      sourceKey: this.selectedKey,
      ...this.captionOptions(index),
      ...caption,
    }));

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

    if (!this._done) {
      this._animationFrameId = window.requestAnimationFrame(() => this._step());
    }
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
    const lineIndex = lineIndexAt(this.lines, this.progress);
    const wordIndex = wordIndexAt(
      lineIndex == null ? undefined : this.lines[lineIndex],
      this.progress,
    );
    const active = `${lineIndex ?? -1}:${wordIndex ?? -1}`;
    // Gate on the string the template actually shows, not on a rounded second.
    // `formatPlayhead` floors; gating on `Math.round` would hold the re-render
    // back across the very boundary where the readout changes, leaving it a
    // second stale.
    const label = playheadLabel(this.progress, this.durationSec());

    if (active === this._shownActive && label === this._shownLabel) {
      return;
    }
    this._shownActive = active;
    this._shownLabel = label;
    this.requestUpdate();
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
    this._done = false;

    if (this._animationFrameId) {
      window.cancelAnimationFrame(this._animationFrameId);
    }
    this._animationFrameId = window.requestAnimationFrame(() => this._step());

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
   * Apply a pure operation from `caption/lines.ts`, with undo.
   *
   * An operation that declines returns its input **by identity**, which is what
   * lets this skip the snapshot: pressing Enter at the end of a line should not
   * fill the undo stack with states identical to the one before.
   */
  private applyLines(next: CaptionLine[]) {
    if (next === this.lines) {
      return false;
    }
    this._undo.push(this.lines);
    if (this._undo.length > UNDO_LIMIT) {
      this._undo.shift();
    }
    this.lines = next;
    this.schedulePaint();
    this.requestUpdate();
    return true;
  }

  /**
   * Undo one split or merge.
   *
   * Typing is left to the input's own native undo — a snapshot per keystroke
   * would bury the structural edits this is for under hundreds of character
   * states, which is the opposite of useful.
   */
  undoEdit() {
    const previous = this._undo.pop();
    if (previous == null) {
      return;
    }
    this.lines = previous;
    this.schedulePaint();
    this.requestUpdate();
  }

  splitLine(index: number, caretOffset: number) {
    if (this.applyLines(splitLineAt(this.lines, index, caretOffset))) {
      // The caret belongs at the start of the new line, as in any editor.
      this.focusLine(index + 1, 0);
    }
  }

  mergeLine(index: number) {
    const caret = mergeCaretOffset(this.lines, index);
    if (this.applyLines(mergeLineWithPrevious(this.lines, index))) {
      this.focusLine(index - 1, caret);
    }
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

  _handleCaptionKeydown(event: KeyboardEvent, index: number) {
    const input = event.target as HTMLInputElement;

    // A Korean IME fires Enter to commit a composition. Splitting on it would
    // cut the line in half every time someone finished typing a word — the
    // reason this is an <input> and not a contenteditable.
    if (event.isComposing || (event as any).keyCode === 229) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      this.splitLine(index, input.selectionStart ?? 0);
      return;
    }

    if (
      event.key === "Backspace" &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      event.preventDefault();
      this.mergeLine(index);
      return;
    }

    if (
      event.key === "Delete" &&
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length &&
      index + 1 < this.lines.length
    ) {
      event.preventDefault();
      this.mergeLine(index + 1);
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      this.undoEdit();
    }
  }

  _handleChangeInput(event: Event, index: number) {
    const value = (event.target as HTMLInputElement).value;
    // Straight to state, no snapshot: typing is the input's own undo to manage.
    this.lines = setLineText(this.lines, index, value);
    this.schedulePaint();
  }

  render() {
    const activeLine = lineIndexAt(this.lines, this.progress);
    const activeWord = wordIndexAt(
      activeLine == null ? undefined : this.lines[activeLine],
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
                ${locale.name}${locale.installed ? "" : " (downloads once)"}
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
                ${this.progressStage == "downloading"
                  ? "Downloading the language model..."
                  : this.progressStage == "extracting"
                    ? "Extracting audio..."
                    : "Transcribing..."}
              </h5>

              <b class="text-secondary"
                >${this.progressStage == "downloading"
                  ? "This happens once per language, and the model stays on this Mac."
                  : "The audio never leaves your computer."}</b
              >

              <progress-bar
                percent="${Math.round(this.progressFraction * 100)}"
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
