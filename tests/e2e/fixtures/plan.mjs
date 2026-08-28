/**
 * What media the E2E suite runs against, and where it comes from.
 *
 * Three tiers, and the split is deliberate:
 *
 *  1. **Real files, downloaded.** Freely-licensed video off Blender's own
 *     servers and Wikimedia Commons. These carry the grubbiness a synthetic
 *     file never has — real GOP structure, real audio that isn't a sine, edit
 *     lists, containers written by encoders nobody in this repo configured.
 *  2. **Derived variants.** Transcodes of (1) that fan the real content out
 *     across every codec, resolution, frame rate and audio layout the app
 *     claims to accept. Deriving rather than downloading twelve separate files
 *     keeps the network surface to four URLs while still putting h265, VP9,
 *     ProRes, 4K, portrait, square, rotated and audioless clips on the
 *     timeline.
 *  3. **Instruments.** Purpose-built carriers that make frame identity
 *     *measurable* — see `instruments.mjs`. These are generated, never
 *     downloaded, because their whole value is that their content at frame N
 *     is known exactly.
 *
 * Sizes below are what the servers reported when this list was written; they
 * are a sanity check, not a hash. `sha256` is the real gate.
 */

export const SOURCES = [
  {
    id: "sintel",
    url: "https://download.blender.org/durian/trailer/sintel_trailer-720p.mp4",
    file: "src/sintel-720p.mp4",
    approxBytes: 7608204,
    sha256: null,
    note: "h264 1280x720 24fps + AAC stereo. CC-BY, Blender Foundation.",
  },
  {
    id: "volcano",
    url: "https://upload.wikimedia.org/wikipedia/commons/transcoded/2/22/Volcano_Lava_Sample.webm/Volcano_Lava_Sample.webm.480p.vp9.webm",
    file: "src/volcano-480p.vp9.webm",
    approxBytes: 20598720,
    sha256: null,
    note: "Real VP9 in WebM. CC0, Wikimedia Commons.",
  },
  {
    id: "bbb",
    url: "https://download.blender.org/peach/trailer/trailer_400p.ogg",
    file: "src/bbb-trailer-400p.ogg",
    approxBytes: 4360399,
    sha256: null,
    note: "Theora video + Vorbis audio in Ogg. An entirely different decoder path from the other three. CC-BY, Blender Foundation.",
  },
  {
    id: "exampleAudio",
    url: "https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg",
    file: "src/example.ogg",
    approxBytes: 104793,
    sha256: null,
    note: "Real Vorbis audio. Public domain, Wikimedia Commons.",
  },
];

/**
 * The clips the scenario places on the timeline.
 *
 * `args` is spliced between the input and the output path, so each entry reads
 * as the ffmpeg command it becomes. `trimSec` caps how much of the source is
 * transcoded — the sources run to a minute or more and the scenario never needs
 * that much of any one of them, so trimming keeps the fixture directory to a
 * few hundred megabytes instead of several gigabytes.
 */
export const VIDEO_VARIANTS = [
  {
    id: "v01-h264-1080p60",
    from: "sintel",
    file: "video/v01-h264-1080p60.mp4",
    trimSec: 30,
    args: [
      "-vf", "scale=1920:1080:flags=bicubic,fps=60",
      "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    ],
    describes: "the ordinary case — matches the project's own resolution and rate exactly",
  },
  {
    id: "v02-h265-720p30",
    from: "sintel",
    file: "video/v02-h265-720p30.mp4",
    trimSec: 25,
    args: [
      "-vf", "fps=30",
      "-c:v", "libx265", "-crf", "26", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-tag:v", "hvc1",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    ],
    describes: "HEVC, and a source rate that is half the project's",
  },
  {
    id: "v03-vp9-540p25",
    from: "sintel",
    file: "video/v03-vp9-540p25.webm",
    trimSec: 20,
    args: [
      "-vf", "scale=960:540,fps=25",
      "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-deadline", "good", "-cpu-used", "6", "-row-mt", "1",
      "-c:a", "libopus", "-b:a", "96k", "-ar", "48000", "-ac", "2",
    ],
    describes: "VP9/Opus in WebM, and 25fps against a 60fps project — the worst rate ratio here",
  },
  {
    id: "v04-prores-480p24",
    from: "sintel",
    file: "video/v04-prores-480p24.mov",
    trimSec: 12,
    args: [
      "-vf", "scale=854:480",
      "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
      "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    ],
    describes: "10-bit intra-only ProRes in MOV with PCM audio — no inter-frame prediction to seek through",
  },
  {
    id: "v05-portrait-1080x1920",
    from: "sintel",
    file: "video/v05-portrait-1080x1920.mp4",
    trimSec: 15,
    args: [
      // `force_original_aspect_ratio=increase` scales the 16:9 source until it
      // covers the 9:16 target, so the crop always has pixels to take. Scaling
      // to width first gives a 608px-tall image and the crop fails.
      "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30",
      "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-an",
    ],
    describes: "portrait, so the fit maths runs the other way round",
  },
  {
    id: "v06-square-1080",
    from: "sintel",
    file: "video/v06-square-1080.mp4",
    trimSec: 15,
    args: [
      "-vf", "scale=1080:1080,fps=30",
      "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    ],
    describes: "square",
  },
  {
    id: "v07-longgop",
    from: "sintel",
    file: "video/v07-longgop.mp4",
    trimSec: 20,
    args: [
      "-vf", "fps=30",
      "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      // A 300-frame GOP with no scene-cut keyframes and deep B-pyramids. The
      // export seeks once per output frame, and a seek into the middle of a GOP
      // this long has to decode its way there from the last keyframe. This is
      // the fixture that makes `loadedAssetStore.seek` work for its living.
      "-g", "300", "-keyint_min", "300", "-sc_threshold", "0",
      "-bf", "8", "-refs", "5",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    ],
    describes: "300-frame GOP with 8 B-frames — every per-frame seek has to decode its way in from the last keyframe",
  },
  {
    id: "v08-noaudio-360p50",
    from: "sintel",
    file: "video/v08-noaudio-360p50.mp4",
    trimSec: 20,
    args: [
      "-vf", "scale=640:360,fps=50",
      "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-an",
    ],
    describes: "no audio stream at all, so `isExistAudio` must stay false and the clip must not reach the mix",
  },
  {
    id: "v09-mono44k",
    from: "sintel",
    file: "video/v09-mono44k.mp4",
    trimSec: 18,
    args: [
      "-vf", "scale=1280:720,fps=24",
      "-c:v", "libx264", "-crf", "24", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-ac", "1",
    ],
    describes: "mono at 44.1k against a stereo 48k export — the resampler has real work to do",
  },
  {
    id: "v10-vfr",
    from: "sintel",
    file: "video/v10-vfr.mp4",
    trimSec: 20,
    args: [
      // Dropping duplicate frames is what actually produces a variable rate;
      // `-fps_mode vfr` alone on a CFR source just re-emits CFR.
      "-vf", "mpdecimate=hi=64*12:lo=64*5:frac=0.33,scale=1280:720",
      "-fps_mode", "vfr",
      "-c:v", "libx264", "-crf", "24", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    ],
    describes: "variable frame rate — timestamps are not a multiple of any single interval",
  },
  {
    id: "v11-volcano-4k30",
    from: "volcano",
    file: "video/v11-volcano-4k30.mp4",
    trimSec: 12,
    args: [
      "-vf", "scale=3840:2160:flags=bicubic,fps=30",
      "-c:v", "libx264", "-crf", "28", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-an",
    ],
    describes: "4K — one decoded frame is 33MB, which is where memory pressure starts to bite",
  },
  {
    id: "v12-volcano-src",
    from: "volcano",
    file: "video/v12-volcano-src.webm",
    trimSec: 15,
    args: ["-c", "copy"],
    describes: "the untouched VP9/WebM download — nothing in this repo re-encoded it",
  },
  {
    id: "v13-bbb-mkv",
    from: "bbb",
    file: "video/v13-bbb-mkv.mkv",
    trimSec: 15,
    args: [
      // Matroska rather than the source's own Ogg. Two reasons, both learned
      // the hard way: `functions/mime.ts` has no entry for `.ogv`, so the app
      // refuses the file outright ("Cartcut has no renderer for ..."); and
      // Chromium removed Theora decoding in M123, so even in a container the
      // app accepts it would decode to nothing. MKV keeps the container
      // diversity this fixture is here for, with a bitstream that decodes.
      "-c:v", "libx264", "-crf", "24", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    ],
    describes: "Matroska — a container none of the other fixtures use",
  },
  {
    id: "v14-av1",
    from: "volcano",
    file: "video/v14-av1.mp4",
    trimSec: 6,
    args: [
      "-vf", "scale=640:360,fps=30",
      // AV1 is slow to encode; six seconds at 360p keeps it to a few seconds
      // while still putting a third video codec family through the decoder.
      "-c:v", "libaom-av1", "-crf", "40", "-cpu-used", "8", "-row-mt", "1",
      "-pix_fmt", "yuv420p",
      "-an",
    ],
    describes: "AV1 — a third codec family, and the newest decoder in Chromium",
  },
];

/**
 * Stills and GIFs.
 *
 * `image` and `gif` are two of the nine filetypes and take entirely separate
 * renderers (`renderer/image.ts`, `renderer/gif.ts` — the latter decodes with
 * gifuct-js and holds every frame in memory), so a scenario without them is not
 * covering the compositor. The alpha PNG matters on its own: it is the only
 * fixture whose own transparency the compositor has to respect.
 */
export const STILL_VARIANTS = [
  {
    id: "i01-still-1080p",
    from: "sintel",
    file: "still/i01-still-1080p.png",
    trimSec: 3,
    args: ["-frames:v", "1", "-vf", "scale=1920:1080", "-pix_fmt", "rgb24"],
    describes: "an opaque still at project resolution",
  },
  {
    id: "i02-alpha",
    from: "sintel",
    file: "still/i02-alpha.png",
    trimSec: 3,
    args: [
      "-frames:v", "1",
      // A radial alpha ramp, so the compositor has real partial transparency to
      // blend rather than a hard cutout.
      "-vf", "scale=640:360,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*min(1,hypot(X-320,Y-180)/220)'",
      "-pix_fmt", "rgba",
    ],
    describes: "a still with a real alpha ramp",
  },
  {
    id: "g01-animated",
    from: "sintel",
    file: "still/g01-animated.gif",
    trimSec: 4,
    args: [
      "-vf", "fps=12,scale=480:270:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      "-loop", "0",
    ],
    describes: "an animated GIF — its own decoder, and every frame held in memory",
  },
];

export const AUDIO_VARIANTS = [
  {
    id: "a01-sintel-stereo48k",
    from: "sintel",
    file: "audio/a01-sintel-stereo48k.m4a",
    trimSec: 40,
    args: ["-vn", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"],
    describes: "real programme audio, stereo 48k",
  },
  {
    id: "a02-example-pcm441",
    from: "exampleAudio",
    file: "audio/a02-example-pcm441.wav",
    trimSec: 10,
    // Decoded out of the real Vorbis download rather than copied: the app's
    // `functions/mime.ts` accepts exactly three audio extensions — mp3, wav and
    // m4a — so `.ogg` is refused outright with "Cartcut has no renderer for
    // ...". The content is still the real recording; only the container
    // changes. See FINDINGS.md.
    args: ["-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2"],
    describes: "real recorded audio as 44.1k stereo PCM — an uncompressed input among compressed ones",
  },
  {
    id: "a03-bbb-mp3-mono44k",
    from: "bbb",
    file: "audio/a03-bbb-mp3-mono44k.mp3",
    trimSec: 30,
    args: ["-vn", "-c:a", "libmp3lame", "-b:a", "128k", "-ar", "44100", "-ac", "1"],
    describes: "MP3, mono, 44.1k — three conversions away from the export format",
  },
];

/**
 * Audio built from scratch, because its content has to be *known*.
 *
 * `a04` alternates tone and silence on a fixed grid, which is what
 * `silencedetect` is checked against: the app decides where this clip sits on
 * the timeline, and the silence pattern in the delivered file has to move with
 * it. `a05` carries the A/V sync clicks — see `instruments.mjs`.
 */
export const SYNTH_AUDIO = [
  {
    id: "a04-tone440-gaps",
    file: "audio/a04-tone440-gaps.wav",
    describes: "440 Hz, two seconds on and one second off, for silencedetect",
    lavfi:
      "sine=frequency=440:sample_rate=48000:duration=30," +
      // Gate to a 3s period: audible for the first 2s of each period.
      "volume=enable='lt(mod(t\\,3)\\,2)':volume=1:eval=frame," +
      "volume=enable='gte(mod(t\\,3)\\,2)':volume=0:eval=frame",
    args: ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1"],
  },
];
