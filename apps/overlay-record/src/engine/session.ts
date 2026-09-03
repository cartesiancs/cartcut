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
import { startAudioWriter, type AudioWriter } from "./audioWriter";
import {
  negotiateEncode,
  startVideoWriter,
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
};

const state: State = {
  settings: DEFAULT_RECORD_SETTINGS,
  platform: "darwin",
  sources: [],
  devices: noDevices,
  status: "idle",
  take: null,
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

/** Push the bubble layout to the overlay so its preview matches the file. */
async function refreshOverlay(): Promise<void> {
  const selection = resolveRecordSelection({
    settings: state.settings,
    screens: screenSources(),
    cameras: state.devices.cameras,
    microphones: state.devices.microphones,
  });

  await bridge.setOverlay({
    drawing: state.settings.drawing,
    recording: state.status === "recording",
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

function composeWithBubble(take: Take) {
  return (ctx: OffscreenCanvasRenderingContext2D, frame: VideoFrame) => {
    ctx.drawImage(frame, 0, 0, take.size.width, take.size.height);

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

    ctx.save();
    bubblePath(ctx, dest, radius);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = Math.max(2, Math.round(take.size.height * 0.0025));
    ctx.stroke();
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

export async function start(): Promise<void> {
  if (state.status !== "idle") {
    return;
  }

  const streams: MediaStream[] = [];

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
    // are not the codec's — a scaled Retina panel can be taller than
    // VideoToolbox will take — and the capture is constrained to a fixed size,
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

    const session = await bridge.start({
      displayId: target.displayId,
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
      streams,
      cameraVideo,
    };

    const onError = (error: Error) => {
      console.error("[record] writer failed", error);
      report(`Recording failed: ${error.message}`);
      void abort();
    };

    take.video = await startVideoWriter({
      track: screen.track,
      codec: encode.codec,
      plan: encode.plan,
      compose: cameraVideo == null ? undefined : composeWithBubble(take),
      onChunk: (bytes) => bridge.append(session.id, "video", bytes),
      onError,
    });

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
    // the session — the same failure `features/record/screenRecord.ts`
    // documents having had.
    screen.track.addEventListener("ended", () => {
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
    streams.forEach(releaseStream);
    await bridge.cancel();
    state.take = null;
    state.status = "idle";
    report(`Could not start: ${(error as Error).message}`);
  }

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
