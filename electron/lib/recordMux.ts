/**
 * The one FFmpeg call a recording makes.
 *
 * The composite pass has already produced a finished H.264 elementary stream in
 * an MP4, and the microphone is on disk as headerless PCM. All that is left is
 * to put them in one file — and the important word is *copy*: `-c:v copy` moves
 * the video's bytes across untouched, so the picture the encoder produced is
 * bit-for-bit the picture the editor receives. Re-encoding here would be a
 * second generation of loss for no gain whatsoever.
 *
 * Two things this call fixes that nothing else can:
 *
 *  - **A real duration.** A stream written incrementally states no length until
 *    its index is finalised, which is why `mediaProbe.ts` carries a
 *    seek-past-the-end trick and why `ImportItem.fallbackDurationMs` exists. A
 *    muxed MP4 states its length in the header and needs neither.
 *  - **`+faststart`.** The index moves to the front, so the editor's first
 *    `<video>` seek does not have to read to the end of a multi-gigabyte file
 *    before it can show frame one.
 *
 * Spawned directly, never through `fluent-ffmpeg`. The bundled binary is
 * FFmpeg 9, whose `-formats` output puts two spaces between the flag column and
 * the name; the wrapper's parser expects one, so its capability list comes back
 * empty and it rejects every `.format(...)` against a binary that supports it.
 * `mcp/analyze.ts` and `mcp/transcribe.ts` spawn for the same reason.
 *
 * The binary's path arrives as an argument rather than being imported from
 * `lib/ffmpeg.ts`, which is the same shape `render/framePipe.ts` uses and for
 * the same reason: that module reaches `electron-is-dev`, which throws outside
 * an Electron process, and this file would then be untestable. Nothing here
 * imports Electron at all.
 */

import { spawn } from "child_process";

/**
 * A raw PCM file, described rather than headed.
 *
 * The recorder writes `.pcm` and not `.wav` on purpose: a WAV header states the
 * data length, which is not known until the recording stops, so a WAV written
 * incrementally has to be patched afterwards — and a patch that fails leaves a
 * file that looks valid and plays as noise. Headerless PCM cannot be wrong
 * about its own length because it never claims one; the format is passed on the
 * command line instead, where it comes from the same constants that wrote it.
 */
export type PcmInput = {
  path: string;
  sampleRate: number;
  channels: number;
};

export type MuxRequest = {
  /**
   * The encoder's output: a bare H.264 elementary stream, Annex-B framed.
   *
   * Not an MP4. Writing one would need a muxer in the renderer, and the only
   * thing a muxer would add here is timestamps — which an elementary stream
   * does not carry and does not need, because the recorder encodes at a *fixed
   * rate*. It takes the newest captured frame on every tick of the target rate
   * and re-encodes the previous one when nothing has changed, so frame `n` is
   * always at `n / fps` and `-r` below is not an assumption, it is the truth.
   *
   * Constant rate is what the editor wants anyway: the timeline is CFR and
   * `features/export/renderTimeline.ts` samples at `frame / fps * 1000`, so a
   * variable-rate source is the thing that has to be reconciled, not the thing
   * that has to be preserved.
   */
  videoPath: string;
  /** The rate that stream was encoded at. */
  fps: number;
  /** Microphone first, system audio second. Either may be absent. */
  audio: PcmInput[];
  outputPath: string;
};

/** AAC at this rate is transparent for speech and small enough to ignore. */
const AUDIO_BITRATE = "192k";

/**
 * Build the argument list.
 *
 * Exported and pure so the argument construction can be read and tested without
 * a binary — the same split `render/framePipe.ts` makes by taking the ffmpeg
 * path as a parameter.
 */
export function muxArgs(request: MuxRequest): string[] {
  // `-r` is an *input* option here, so it tells the raw H.264 demuxer what the
  // stream's rate is rather than asking for a conversion. Placed before `-i`,
  // which is what makes it one; after it, ffmpeg would resample the timing of a
  // stream that is already correct.
  const args = [
    "-y",
    "-v",
    "error",
    "-r",
    String(request.fps),
    "-f",
    "h264",
    "-i",
    request.videoPath,
  ];

  for (const input of request.audio) {
    args.push(
      "-f",
      "s16le",
      "-ar",
      String(input.sampleRate),
      "-ac",
      String(input.channels),
      "-i",
      input.path,
    );
  }

  if (request.audio.length === 0) {
    args.push("-map", "0:v");
  } else if (request.audio.length === 1) {
    args.push("-map", "0:v", "-map", "1:a");
  } else {
    // `normalize=0` is not optional. `amix` divides by the number of inputs by
    // default, so mixing a microphone with system audio would halve both — a
    // recording that is quiet for a reason nothing on screen explains.
    // `duration=longest` keeps whichever source ran on, rather than cutting the
    // mix when the shorter one ends.
    const inputs = request.audio
      .map((_, index) => `[${index + 1}:a]`)
      .join("");

    args.push(
      "-filter_complex",
      `${inputs}amix=inputs=${request.audio.length}:duration=longest:normalize=0[aout]`,
      "-map",
      "0:v",
      "-map",
      "[aout]",
    );
  }

  // `-bsf:v h264_mp4toannexb` is deliberately absent: that filter converts the
  // other way. An MP4 needs length-prefixed AVCC, and the mp4 muxer performs
  // that conversion itself when the input is Annex-B, so `copy` here is a
  // re-framing of the same coded bytes and not a re-encode.
  args.push("-c:v", "copy");

  if (request.audio.length > 0) {
    args.push("-c:a", "aac", "-b:a", AUDIO_BITRATE);
  }

  // Deliberately no `-shortest`. It cuts to whichever stream ends first, which
  // would truncate the *picture* whenever the microphone stopped a frame early
  // — losing recorded video to tidy up a few milliseconds of silence. A short
  // audio tail past the last frame costs nothing: the editor reads the
  // container's duration and the difference is under one frame either way.
  args.push("-movflags", "+faststart", request.outputPath);

  return args;
}

/**
 * Run it.
 *
 * Rejects with FFmpeg's own stderr rather than an exit code: the caller shows
 * this to a user who has just lost a take, and "ffmpeg exited 1" tells them
 * nothing they can act on.
 */
export function muxRecording(
  ffmpegPath: string,
  request: MuxRequest,
): Promise<string> {
  const args = muxArgs(request);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Could not run ffmpeg: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(request.outputPath);
        return;
      }

      reject(
        new Error(
          `ffmpeg exited ${code} while writing the recording. ${stderr.trim()}`,
        ),
      );
    });
  });
}
