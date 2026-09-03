/**
 * Opening the four capture streams.
 *
 * The screen goes through `getUserMedia` with Chromium's desktop constraints
 * rather than `getDisplayMedia`, for the reason
 * `apps/app/src/features/record/screenRecord.ts` states in its header: it
 * captures the source the user picked, and it does so without a picker dialog.
 * `getDisplayMedia` is reached for exactly one thing — system audio, which the
 * desktop constraints cannot ask for — and `electron/lib/displayMedia.ts`
 * explains the one-shot arrangement behind that.
 *
 * Two constraints here are doing the quality work, and both are absent from the
 * in-panel recorder:
 *
 *  - **The size is pinned, not capped.** `min` and `max` are both the display's
 *    own pixel count. A bare `maxWidth: 1920` lets Chromium hand back whatever
 *    it likes up to that, and on a Retina panel what it likes is a downscale
 *    that turns text to mush before the encoder ever sees it.
 *  - **`contentHint = "detail"`.** It tells the encoder to spend its bitrate on
 *    spatial detail rather than on temporal smoothness. That is the right trade
 *    for a screen — a still page of text is the common case and a dropped frame
 *    during a scroll is not what anyone notices — and it is precisely wrong for
 *    the camera, which gets `"motion"`.
 */

import type { Size } from "@app/features/record/captureSettings";

export type ScreenCapture = {
  stream: MediaStream;
  track: MediaStreamTrack;
};

/**
 * Capture one screen or window at a fixed size and rate.
 *
 * `mandatory` is the legacy Chromium constraint bag — non-standard, and the
 * only way to name a `desktopCapturer` source. TypeScript's DOM lib does not
 * describe it, hence the cast.
 */
export async function captureScreen(
  sourceId: string,
  size: Size,
  fps: number,
): Promise<ScreenCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        minWidth: size.width,
        maxWidth: size.width,
        minHeight: size.height,
        maxHeight: size.height,
        maxFrameRate: fps,
      },
    },
  } as unknown as MediaStreamConstraints);

  const track = stream.getVideoTracks()[0];

  if (track == null) {
    stream.getTracks().forEach((each) => each.stop());
    throw new Error("That screen produced no picture.");
  }

  track.contentHint = "detail";

  return { stream, track };
}

/**
 * The camera, at 720p.
 *
 * Not the camera's maximum. The bubble is a fifth of the frame's height at
 * most, so anything past 720p is pixels that get thrown away in the composite —
 * and asking a webcam for its full resolution is the difference between a
 * stream that starts in 200ms and one that starts in two seconds.
 *
 * `ideal` rather than `exact` throughout: a camera that cannot do 1280×720
 * should give its nearest size, not fail the take.
 */
export async function captureCamera(
  deviceId: string,
  size: Size,
  fps: number,
): Promise<ScreenCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      deviceId: deviceId.length > 0 ? { exact: deviceId } : undefined,
      width: { ideal: size.width },
      height: { ideal: size.height },
      frameRate: { ideal: fps },
    },
  });

  const track = stream.getVideoTracks()[0];

  if (track == null) {
    stream.getTracks().forEach((each) => each.stop());
    throw new Error("That camera produced no picture.");
  }

  track.contentHint = "motion";

  return { stream, track };
}

/**
 * The microphone, with the browser's speech processing switched off.
 *
 * `echoCancellation`, `noiseSuppression` and `autoGainControl` are on by
 * default because the default caller is a video call. All three are wrong for a
 * recording: AGC pumps the level between sentences, noise suppression chews the
 * tails off words, and echo cancellation ducks the microphone whenever the
 * machine plays a sound — which, while recording a screen, it does constantly.
 * The editor can do all three afterwards, to a signal that still has the
 * information in it.
 */
export async function captureMicrophone(
  deviceId: string,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: false,
    audio: {
      deviceId: deviceId.length > 0 ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: 48_000 },
    },
  });
}

/**
 * The system's own output, on Windows.
 *
 * The video half of this stream is opened and immediately stopped: `loopback`
 * audio can only be asked for as part of a display-media request, so a picture
 * has to be requested to get at the sound, and keeping it would mean capturing
 * the same screen twice.
 *
 * Returns `null` rather than throwing when the platform declines. Electron 33
 * documents `Streams.audio` as Windows-only, and
 * `recordSettings.ts#systemAudioSupported` is what stops this being called
 * elsewhere — but a Windows machine can still refuse, and a take without system
 * audio is better than no take.
 */
export async function captureSystemAudio(
  sourceId: string,
  arm: (sourceId: string, audio: boolean) => Promise<unknown>,
  disarm: () => Promise<unknown>,
): Promise<MediaStream | null> {
  try {
    await arm(sourceId, true);

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    stream.getVideoTracks().forEach((track) => {
      track.stop();
      stream.removeTrack(track);
    });

    return stream.getAudioTracks().length > 0 ? stream : null;
  } catch (error) {
    console.warn("[record] system audio unavailable", error);
    return null;
  } finally {
    await disarm();
  }
}

/** Stop every track on a stream, if there is one. Safe to call twice. */
export function releaseStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
