/**
 * The recorder's state machine.
 *
 * Everything the recorder decides is decided here: what the tray says, what the
 * capture is configured as, when the encoders start and stop, and what gets
 * handed to the main process at the end. Main is a switchboard — it renders the
 * menu this module builds and writes the bytes this module produces — and the
 * editor hears about a recording exactly once, when there is a finished file.
 *
 * The rules that are easy to get wrong, and where they live:
 *
 *  - **Nothing about the capture may change once it has started.** The encoder
 *    is configured from the size and rate and is already running.
 *    `trayModel.ts` disables those rows; this module never re-reads them
 *    mid-take.
 *  - **A stored device id is a preference, not a guarantee.**
 *    `resolveRecordSelection` maps it onto what is actually present, and both
 *    the menu's ticks and the capture request go through it, so what the menu
 *    says is being recorded is what is being recorded.
 *  - **The camera is composited, never captured twice.** It is drawn into the
 *    same canvas the screen is, on the encoder's own clock, so there is one
 *    encode generation and one file. The overlay window shows the same layout
 *    live and is excluded from capture by `setContentProtection`, so the bubble
 *    appears once.
 */

import {
  bubbleCornerRadius,
  bubbleRect,
  bubbleSourceRect,
  type Rect,
} from "@app/features/record/bubbleLayout";
import {
  CAMERA_CAPTURE,
  captureSizeFor,
  type Size,
} from "@app/features/record/captureSettings";
import {
  COUNTDOWN_FROM,
  COUNTDOWN_STEP_MS,
  startCountdown,
  type Countdown,
} from "@app/features/record/countdown";
import {
  applyRecordSettings,
  DEFAULT_RECORD_SETTINGS,
  effectiveSystemAudio,
  normalizeRecordSettings,
  type RecordSettings,
} from "@app/features/record/recordSettings";
import {
  buildTrayModel,
  parseTrayId,
  resolveRecordSelection,
  settingsPatch,
  type RecorderState,
  type ScreenSource,
} from "@app/features/record/trayModel";
import { bridge, type CaptureSource } from "../bridge";
import {
  captureCamera,
  captureMicrophone,
  captureScreen,
  captureSystemAudio,
  releaseStream,
} from "./capture";
import { enumerate, noDevices, primeLabels, type Devices } from "./devices";
import { paintStroke } from "../paintStroke";
import {
  applyStrokeMessage,
  clearStrokes,
  hasStrokes,
  visibleStrokes,
  type StrokeMessage,
} from "./strokeStore";
import { startAudioWriter, type AudioWriter } from "./audioWriter";
import {
  holdNewestFrame,
  negotiateEncode,
  startVideoWriter,
  type FrameHolder,
  type VideoWriter,
} from "./videoWriter";

type Take = {
  id: string;
  fps: number;
  size: Size;
  video: VideoWriter;
  mic: AudioWriter | null;
  system: AudioWriter | null;
  streams: MediaStream[];
  cameraVideo: HTMLVideoElement | null;
};

type State = {
  settings: RecordSettings;
  platform: string;
  sources: CaptureSource[];
  devices: Devices;
  status: RecorderState;
  take: Take | null;
  /** The count in progress, so the tray's Cancel can stop it. */
  countdown: Countdown | null;
  /** The number the overlay shows, or `null` for none. */
  countdownValue: number | null;
};

const state: State = {
  settings: DEFAULT_RECORD_SETTINGS,
  platform: "darwin",
  sources: [],
  devices: noDevices,
  status: "idle",
  take: null,
  countdown: null,
  countdownValue: null,
};

function report(message: string): void {
  const status = document.getElementById("status");
  if (status != null) {
    status.textContent = message;
  }
}

function screenSources(): ScreenSource[] {
  return state.sources.map((source) => ({ id: source.id, name: source.name }));
}

/** Rebuild the menu from the current state and hand it to main. */
async function refreshTray(): Promise<void> {
  await bridge.setTray(
    buildTrayModel({
      settings: state.settings,
      state: state.status,
      screens: screenSources(),
      cameras: state.devices.cameras,
      microphones: state.devices.microphones,
      platform: state.platform,
    }),
  );
}

async function persist(): Promise<void> {
  await bridge.saveSettings(state.settings);
}

/**
 * Push the bubble layout to the overlay so its preview matches the file.
 *
 * `displayId` is what moves the overlay window onto the screen being captured.
 * It has to come from here because the engine owns the selection and main is
 * told rather than asked: see `lib/overlayPlacement.ts`. A window source has no
 * display, and sends the empty string, which main reads as "stay put".
 */
async function refreshOverlay(): Promise<void> {
  const selection = resolveRecordSelection({
    settings: state.settings,
    screens: screenSources(),
    cameras: state.devices.cameras,
    microphones: state.devices.microphones,
  });

  const source = state.sources.find(
    (candidate) => candidate.id === selection.screenSourceId,
  );

  await bridge.setOverlay({
    drawing: state.settings.drawing,
    recording: state.status === "recording",
    countdown: state.countdownValue,
    displayId: source?.displayId ?? "",
    cameraDeviceId: selection.cameraDeviceId,
    bubbleSize: state.settings.bubbleSize,
    bubbleCorner: state.settings.bubbleCorner,
    bubbleShape: state.settings.bubbleShape,
  });
}

/** The display behind the selected source, and the frame size to ask it for. */
function captureTarget(): {
  source: CaptureSource;
  size: Size;
  displayId: string;
} {
  const selection = resolveRecordSelection({
    settings: state.settings,
    screens: screenSources(),
    cameras: state.devices.cameras,
    microphones: state.devices.microphones,
  });

  const source = state.sources.find(
    (candidate) => candidate.id === selection.screenSourceId,
  );

  if (source == null) {
    throw new Error("There is no screen to capture.");
  }

  // A window source has no display, so its pixel count is unknown ahead of
  // time; 1080p is the honest guess there. A screen source knows exactly, and
  // that is the number that matters — see `captureSettings.ts`.
  const display = source.display ?? {
    width: 1920,
    height: 1080,
    scaleFactor: 1,
  };

  return {
    source,
    size: captureSizeFor(display, state.settings.quality),
    displayId: source.displayId,
  };
}

/**
 * A rounded rectangle, filled under the identity transform.
 *
 * `roundRect` is safe *here* — the canvas is at identity and the bubble is
 * axis-aligned, so no corner is being asked to survive a non-similarity
 * transform. `features/mask/round.ts` refuses it for exactly the case this is
 * not: a mask under an arbitrary affine, where a circular arc has to become an
 * elliptical one.
 */
function bubblePath(
  ctx: OffscreenCanvasRenderingContext2D,
  rect: Rect,
  radius: number,
): void {
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
}

/**
 * Draw the annotations, in the capture's own pixels.
 *
 * Re-stroked from the points rather than captured from the overlay, which is
 * what keeps them crisp: a line burned into the picture at capture resolution
 * would soften under any later scaling, and a vector one does not. It is also
 * the only way they can be drawn at all — the overlay is content-protected and
 * therefore invisible to the capture, by design.
 */
function drawStrokes(
  ctx: OffscreenCanvasRenderingContext2D,
  size: Size,
  now: number,
): void {
  for (const { stroke, alpha } of visibleStrokes(now)) {
    paintStroke(ctx, stroke.points, stroke.color, {
      width: size.width,
      height: size.height,
      widthN: stroke.widthN,
      alpha,
    });
  }
}

function composeFrame(take: Take) {
  return (ctx: OffscreenCanvasRenderingContext2D, frame: VideoFrame) => {
    ctx.drawImage(frame, 0, 0, take.size.width, take.size.height);

    // Under the bubble: the bubble is a fixed piece of furniture and should
    // never be drawn over, whereas an annotation is about the picture.
    drawStrokes(ctx, take.size, performance.now());

    const video = take.cameraVideo;
    if (video == null || video.readyState < 2 || video.videoWidth === 0) {
      return;
    }

    const source = { width: video.videoWidth, height: video.videoHeight };
    const dest = bubbleRect(
      take.size,
      source,
      state.settings.bubbleSize,
      state.settings.bubbleCorner,
      state.settings.bubbleShape,
    );
    const crop = bubbleSourceRect(source, dest);
    const radius = bubbleCornerRadius(dest, state.settings.bubbleShape);

    ctx.save();
    bubblePath(ctx, dest, radius);
    ctx.clip();

    // Mirrored, matching the live preview in the overlay and what everyone
    // expects of their own camera. The two have to agree: a bubble that is
    // mirrored while recording and not in the file is a person who spends the
    // take looking at the wrong side of their face.
    ctx.translate(dest.x + dest.width, dest.y);
    ctx.scale(-1, 1);
    ctx.drawImage(
      video,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      dest.width,
      dest.height,
    );
    ctx.restore();
  };
}

/** A detached `<video>` decoding the camera, for the compositor to draw. */
async function cameraElement(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;

  await video.play().catch(() => {
    // A detached, muted element is allowed to autoplay. If a policy ever says
    // otherwise the compositor draws no bubble rather than failing the take —
    // `composeWithBubble` checks `readyState` on every frame.
  });

  return video;
}

/** Everything a take needs that can be opened before it begins. */
type Prepared = {
  displayId: string;
  encode: Awaited<ReturnType<typeof negotiateEncode>>;
  screenTrack: MediaStreamTrack;
  frames: FrameHolder;
  cameraVideo: HTMLVideoElement | null;
  micStream: MediaStream | null;
  systemStream: MediaStream | null;
  streams: MediaStream[];
};

/**
 * Open every device the take will record, and write nothing.
 *
 * Run while the countdown is on screen, so the first frame lands when the count
 * reaches zero rather than a device-open later. A camera also spends its first
 * second finding its exposure, and this way that second is spent before the
 * take instead of at the start of it.
 *
 * Nothing is written here. The screen's newest frame is held from the moment
 * the capture opens, so that `begin` has a picture for frame 0 at once (see
 * `holdNewestFrame`); the audio writers attach in `begin`, so no sample from
 * the countdown reaches the file. Releases what it opened if any step fails.
 */
async function prepare(): Promise<Prepared> {
  const streams: MediaStream[] = [];
  let frames: FrameHolder | null = null;

  try {
    // Re-read the sources: ids are minted per enumeration and the display list
    // may have changed since the menu was last built.
    state.sources = await bridge.sources();

    const target = captureTarget();
    const selection = resolveRecordSelection({
      settings: state.settings,
      screens: screenSources(),
      cameras: state.devices.cameras,
      microphones: state.devices.microphones,
    });

    // Negotiate *before* opening the capture. A hardware encoder's real limits
    // are not the codec's (a scaled Retina panel can be taller than
    // VideoToolbox will take) and the capture is constrained to a fixed size,
    // so the encoder has to have agreed to it first. `negotiateEncode` walks
    // down `captureSizeLadder` until something says yes.
    const encode = await negotiateEncode(
      selection.cameraDeviceId === "" ? "screen" : "composite",
      target.size,
      state.settings.fps,
    );

    const screen = await captureScreen(
      target.source.id,
      encode.size,
      state.settings.fps,
    );
    streams.push(screen.stream);
    frames = holdNewestFrame(screen.track);

    let cameraVideo: HTMLVideoElement | null = null;
    if (selection.cameraDeviceId !== "") {
      const camera = await captureCamera(
        selection.cameraDeviceId,
        CAMERA_CAPTURE,
        CAMERA_CAPTURE.fps,
      );
      streams.push(camera.stream);
      cameraVideo = await cameraElement(camera.stream);
    }

    let micStream: MediaStream | null = null;
    if (selection.micDeviceId !== "") {
      micStream = await captureMicrophone(selection.micDeviceId);
      streams.push(micStream);
    }

    let systemStream: MediaStream | null = null;
    if (effectiveSystemAudio(state.settings, state.platform)) {
      systemStream = await captureSystemAudio(
        target.source.id,
        bridge.armDisplayMedia,
        bridge.disarmDisplayMedia,
      );
      if (systemStream != null) {
        streams.push(systemStream);
      }
    }

    return {
      displayId: target.displayId,
      encode,
      screenTrack: screen.track,
      frames,
      cameraVideo,
      micStream,
      systemStream,
      streams,
    };
  } catch (error) {
    void frames?.stop();
    streams.forEach(releaseStream);
    throw error;
  }
}

function releasePrepared(prepared: Prepared): void {
  void prepared.frames.stop();
  prepared.streams.forEach(releaseStream);
  if (prepared.cameraVideo != null) {
    prepared.cameraVideo.srcObject = null;
  }
}

/**
 * Count down on the overlay, then record.
 *
 * The devices open during the count, not after it. The numeral stays up until
 * the writers are running and is cleared by `begin`, so the moment it leaves
 * the screen is the moment the recording starts. If opening takes longer than
 * the count (a first-run permission prompt, say), the last number simply stays
 * up until it is done.
 */
export async function start(): Promise<void> {
  if (state.status !== "idle") {
    return;
  }

  state.status = "countdown";
  const countdown = startCountdown({
    from: COUNTDOWN_FROM,
    stepMs: COUNTDOWN_STEP_MS,
    onStep: (remaining) => {
      state.countdownValue = remaining;
      void refreshOverlay();
    },
  });
  state.countdown = countdown;
  await refreshTray();

  type Opened = { ok: true; prepared: Prepared } | { ok: false; error: Error };
  const opening: Promise<Opened> = prepare().then(
    (prepared) => ({ ok: true as const, prepared }),
    (error) => {
      // No point counting down to a recording that cannot happen.
      countdown.cancel();
      return { ok: false as const, error: error as Error };
    },
  );

  const [counted, opened] = await Promise.all([countdown.done, opening]);
  state.countdown = null;

  if (!opened.ok || !counted) {
    if (opened.ok) {
      releasePrepared(opened.prepared);
    }
    state.countdownValue = null;
    state.status = "idle";
    report(
      opened.ok
        ? "Cancelled before the recording began."
        : `Could not start: ${opened.error.message}`,
    );
    await refreshTray();
    await refreshOverlay();
    return;
  }

  await begin(opened.prepared);
}

/** Start the clock and the writers on devices `prepare` already opened. */
async function begin(prepared: Prepared): Promise<void> {
  const { encode, screenTrack, micStream, systemStream } = prepared;
  // Held outside the `try` so a failure after it started can still stop it,
  // rather than leaving its encode loop ticking with nothing to encode.
  let video: VideoWriter | null = null;

  try {
    // The user can end a share from the OS chrome while the numbers count, and
    // a writer attached to an ended track produces a file with no frames in it.
    if (screenTrack.readyState === "ended") {
      throw new Error("The screen capture ended before the recording began.");
    }

    const session = await bridge.start({
      displayId: prepared.displayId,
      captureWidth: encode.size.width,
      captureHeight: encode.size.height,
    });

    const take: Take = {
      id: session.id,
      fps: state.settings.fps,
      size: encode.size,
      video: null as unknown as VideoWriter,
      mic: null,
      system: null,
      streams: prepared.streams,
      cameraVideo: prepared.cameraVideo,
    };

    const onError = (error: Error) => {
      console.error("[record] writer failed", error);
      report(`Recording failed: ${error.message}`);
      void abort();
    };

    video = await startVideoWriter({
      frames: prepared.frames,
      codec: encode.codec,
      plan: encode.plan,
      compose: composeFrame(take),
      // Drawing can be switched on mid-take, so this is asked per frame. With
      // no camera and nothing drawn, every frame takes the zero-copy path.
      shouldCompose: () => take.cameraVideo != null || hasStrokes(),
      onChunk: (bytes) => bridge.append(session.id, "video", bytes),
      onError,
    });
    take.video = video;

    if (micStream != null) {
      take.mic = await startAudioWriter({
        stream: micStream,
        onChunk: (bytes) => bridge.append(session.id, "mic", bytes),
        onError,
      });
    }

    if (systemStream != null) {
      take.system = await startAudioWriter({
        stream: systemStream,
        onChunk: (bytes) => bridge.append(session.id, "system", bytes),
        onError,
      });
    }

    // Ending the share from the OS chrome ends the track and tells us nothing.
    // Without this the recorder believes it is still recording for the rest of
    // the session, the same failure `features/record/screenRecord.ts`
    // documents having had.
    screenTrack.addEventListener("ended", () => {
      if (state.status === "recording" || state.status === "paused") {
        void stop();
      }
    });

    state.take = take;
    state.status = "recording";
    report(
      `Recording ${encode.size.width}×${encode.size.height} at ${state.settings.fps}fps` +
        ` (${encode.codec}, ${Math.round(encode.plan.bitrate / 1e6)} Mbps)`,
    );
  } catch (error) {
    await video?.stop().catch(() => {});
    releasePrepared(prepared);
    await bridge.cancel();
    state.take = null;
    state.status = "idle";
    report(`Could not start: ${(error as Error).message}`);
  }

  state.countdownValue = null;
  await refreshTray();
  await refreshOverlay();
}

async function teardown(take: Take): Promise<void> {
  await take.video.stop().catch((error) => {
    console.error("[record] could not close the video stream", error);
  });
  await take.mic?.stop().catch(() => {});
  await take.system?.stop().catch(() => {});

  take.streams.forEach(releaseStream);

  if (take.cameraVideo != null) {
    take.cameraVideo.srcObject = null;
  }

  await bridge.finishFile(take.id, "video");
  if (take.mic != null) {
    await bridge.finishFile(take.id, "mic");
  }
  if (take.system != null) {
    await bridge.finishFile(take.id, "system");
  }
}

export async function stop(): Promise<void> {
  const take = state.take;
  if (take == null || (state.status !== "recording" && state.status !== "paused")) {
    return;
  }

  state.status = "processing";
  state.take = null;
  await refreshTray();
  await refreshOverlay();
  report("Finishing the recording…");

  try {
    await teardown(take);
    await bridge.stop(take.id);

    const filePath = await bridge.deliver(take.id, {
      fps: take.fps,
      audio: [
        ...(take.mic == null
          ? []
          : [
              {
                key: "mic" as const,
                sampleRate: take.mic.sampleRate,
                channels: take.mic.channels,
              },
            ]),
        ...(take.system == null
          ? []
          : [
              {
                key: "system" as const,
                sampleRate: take.system.sampleRate,
                channels: take.system.channels,
              },
            ]),
      ],
    });

    report(`Saved ${filePath}`);
  } catch (error) {
    console.error("[record] could not finish the recording", error);
    report(`Could not finish: ${(error as Error).message}`);
    await bridge.cancel();
  }

  state.status = "idle";
  await refreshTray();
  await refreshOverlay();
}

/** Throw the take away — a failure mid-recording, or the user's Discard. */
export async function abort(): Promise<void> {
  // Before the first frame there is no take to throw away, only a count to
  // stop. `start` is awaiting it, and releases the devices it opened.
  if (state.status === "countdown") {
    state.countdown?.cancel();
    return;
  }

  const take = state.take;
  state.take = null;
  state.status = "idle";

  if (take != null) {
    await teardown(take).catch(() => {
      // Already failing; there is nothing better to do than let go.
    });
  }

  await bridge.cancel();
  await refreshTray();
  await refreshOverlay();
}

async function setPaused(paused: boolean): Promise<void> {
  const take = state.take;
  if (take == null) {
    return;
  }

  if (paused && state.status === "recording") {
    take.video.pause();
    take.mic?.pause();
    take.system?.pause();
    await bridge.pause(take.id);
    state.status = "paused";
  } else if (!paused && state.status === "paused") {
    take.video.resume();
    take.mic?.resume();
    take.system?.resume();
    await bridge.resume(take.id);
    state.status = "recording";
  }

  await refreshTray();
  await refreshOverlay();
}

/**
 * Turn drawing on or off, from wherever the request came.
 *
 * Both the tray checkbox and the overlay's own Done button land here, so there
 * is one path and one place that clears the annotations. Leaving them behind on
 * the way out would put lines over an interface the user can click again and no
 * longer has a pen to erase with.
 */
export async function applyDrawing(value: boolean): Promise<void> {
  const next = applyRecordSettings(state.settings, { drawing: value });

  if (next === state.settings) {
    return;
  }

  state.settings = next;

  if (!value) {
    clearStrokes();
  }

  await persist();
  await refreshTray();
  await refreshOverlay();
}

/**
 * A tray click.
 *
 * The id is opaque to the main process, which is what keeps a new setting from
 * touching anything on that side. `parseTrayId` is its only reader, and it
 * answers `null` for anything it does not recognise rather than throwing — a
 * menu left on screen by an older build should be a no-op, not an exception in
 * the middle of a take.
 */
export async function handleTrayClick(id: string): Promise<void> {
  const action = parseTrayId(id);
  if (action == null) {
    return;
  }

  if (action.kind === "command") {
    switch (action.command) {
      case "start":
        await start();
        return;
      case "stop":
        await stop();
        return;
      case "pause":
        await setPaused(true);
        return;
      case "resume":
        await setPaused(false);
        return;
      case "cancel":
        await abort();
        return;
      case "openFolder":
        await bridge.openFolder();
        return;
      case "quit":
        await bridge.close();
        return;
      default:
        return;
    }
  }

  const patch = settingsPatch(action, state.settings);
  if (patch == null) {
    return;
  }

  // Drawing goes through the one path that also clears what is on screen.
  if (action.kind === "toggle" && action.key === "drawing") {
    await applyDrawing(patch.drawing === true);
    return;
  }

  const next = applyRecordSettings(state.settings, patch);

  // Declined by identity: the value was already this, or it was unusable. Both
  // mean there is nothing to write and no menu to rebuild.
  if (next === state.settings) {
    return;
  }

  state.settings = next;
  await persist();
  await refreshTray();
  await refreshOverlay();
}

export async function init(): Promise<void> {
  state.platform = await bridge.platform();
  state.settings = normalizeRecordSettings(await bridge.loadSettings());

  // Before enumerating, so the menu has names in it rather than three blanks.
  // Doing it now rather than at the first frame means the OS prompt lands while
  // the user is still choosing, not after they have started talking.
  await primeLabels();

  state.devices = await enumerate();
  state.sources = await bridge.sources();

  bridge.onTrayClick((id) => {
    void handleTrayClick(id);
  });

  // Annotations, made in the overlay window and relayed by main. Stamped with
  // *this* renderer's clock on arrival, which is the clock the compositor fades
  // them against — the two windows' `performance.now()` share no epoch.
  bridge.onStroke((message: StrokeMessage) => {
    applyStrokeMessage(message, performance.now());
  });

  // The overlay's Done button and its Escape key. Routed through the setting
  // rather than applied locally, so the tray's tick, the overlay's appearance
  // and the compositor's behaviour keep describing one state.
  bridge.onSetDrawing((value) => {
    void applyDrawing(value);
  });

  // Devices come and go. Re-enumerating on the event rather than on a timer
  // means a camera plugged in mid-session appears in the menu without the user
  // having to reopen anything.
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void (async () => {
      state.devices = await enumerate();
      await refreshTray();
    })();
  });

  await refreshTray();
  await refreshOverlay();
  report("Ready. Use the tray icon to start recording.");
}
