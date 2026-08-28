/**
 * The measuring instruments the frame-parity check reads.
 *
 * Ordinary footage cannot answer "is exported frame N the frame the timeline
 * has at N/fps?". Measured on this repo's own ffmpeg: a full one-frame shift
 * moves whole-frame mean absolute error from 1.05 to 1.50 on a moving-box
 * fixture — 1.4x, which is inside codec noise — and SSIM from 0.9987 to 0.9886,
 * which is above any threshold that would not flake. The instruments below
 * exist to turn that 1.4x into something unmissable.
 *
 * Four of them, each answering a different question:
 *
 *  - `code`   — what frame is this, exactly? An integer, read from binary
 *               patches, with no tolerance at all.
 *  - `ticker` — a continuous alignment metric. A one-frame shift moves its MAE
 *               from 0.00 to ~107 (measured), so a best-match search over a
 *               window has a margin of roughly 50-100x over codec noise and can
 *               report the *direction* of a shift, which the code strip cannot.
 *  - `swatch` — did the RGB -> YUV -> RGB round trip stay honest? Eight known
 *               colours, checked absolutely, so the fidelity thresholds are
 *               never asked to distinguish "a real difference" from "the file
 *               was decoded with the wrong matrix".
 *  - `sync`   — an audible click and a visible flash generated on the *same*
 *               frame numbers, in one place, so A/V sync is a property of the
 *               fixture rather than something two independently-placed clips
 *               have to be trusted to preserve.
 *
 * Generation notes worth keeping:
 *
 *  - The code strip uses `drawbox` with an `enable` expression, not `geq`.
 *    `geq` is a per-pixel interpreter: at 1440x96 over 18000 frames that is 2.5
 *    billion evaluations. `enable` is evaluated once per filter per frame — 15
 *    per frame, 270k for the whole clip — and produces identical output. The
 *    full-scale strip generates in 15 seconds.
 *  - The frame index is plain binary, not Gray coded. Gray coding buys
 *    single-bit-error tolerance, and there is no error to tolerate: patches
 *    decode as exactly 0 or 255 even at crf 28 / preset veryfast, a margin of
 *    128 codes against a threshold that needs one.
 *  - Do NOT encode the frame index as a luminance *level* (the obvious
 *    `lum = 2*N`). It was tried and it fails: crf quantisation plus the
 *    limited-range round trip perturbs a flat field by a code or two, so a true
 *    0,2,4,6,8 reads back as 0,1,1,2,4. Binary patches at the extremes only.
 *  - `-loop 1 -i tile.png` defaults to 25fps regardless of the output rate, and
 *    a trailing `fps=60` then *duplicates* frames rather than advancing `n`.
 *    The ticker built that way advances in blocks of three and is silently
 *    useless as an alignment carrier. `-framerate` on the input is what makes
 *    `n` advance once per output frame.
 */

import { even, regionsFor, frameCount, SWATCH_COLORS, TICKER_SHIFT_PX, TICKER_BLOCK_PX } from "./geometry.mjs";

/** Colour tags are explicit here so the app's decode of these is unambiguous. */
const BT709 = [
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-colorspace", "bt709",
  "-color_range", "tv",
];

/**
 * ffmpeg's expression syntax uses `,` to separate arguments and filters both,
 * so a comma inside an option value has to be escaped. Arguments reach ffmpeg
 * through `spawn` with no shell in between, so this is the only escaping there
 * is — there is no second layer to account for.
 */
const esc = (expr) => expr.replace(/,/g, "\\,");

/** The frame-index strip: one patch per bit, white where the bit is set. */
export function codeStripJob(profile, outPath) {
  const { code } = regionsFor(profile);
  const boxes = Array.from({ length: code.bits }, (_, k) =>
    `drawbox=x=${k * code.patch}:y=0:w=${code.patch}:h=${code.h}` +
    `:color=white:t=fill:enable='${esc(`eq(bitand(floor(n/${2 ** k}),1),1)`)}'`,
  ).join(",");

  return {
    label: `code (${code.bits} bits, ${code.w}x${code.h})`,
    args: [
      "-f", "lavfi",
      "-i", `color=c=black:s=${code.w}x${code.h}:r=${profile.fps}:d=${profile.durationSec},${boxes}`,
      // Lossless 4:4:4 so the app's own decode of this input cannot be the
      // thing that blurs a patch edge. The patches are far larger than any
      // plausible kernel anyway, but this removes the question entirely.
      "-c:v", "libx264", "-crf", "0", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      ...BT709,
      outPath,
    ],
  };
}

/**
 * The alignment carrier: a pseudo-random block pattern scrolling horizontally.
 *
 * `tile=2x1` duplicates the pattern so the crop window never spans a
 * discontinuity — the wrap is seamless by construction, whatever the pattern's
 * own period happens to be. Blocks are 4px rather than 1px so a pixel of
 * resampling cannot decorrelate an *aligned* comparison, while a 32px-per-frame
 * shift still lands the pattern somewhere completely different.
 */
export function tickerJobs(profile, tilePath, outPath) {
  const { ticker } = regionsFor(profile);
  const B = TICKER_BLOCK_PX;
  const X = `floor(X/${B})`;
  const Y = `floor(Y/${B})`;

  return [
    {
      label: `ticker tile (${ticker.w}x${ticker.h})`,
      args: [
        "-f", "lavfi",
        "-i",
        `nullsrc=s=${ticker.w}x${ticker.h},format=gray,` +
        `geq=lum='${esc(`if(gt(mod(${X}*${X}*13+${X}*7+${Y}*${Y}*5,251),125),235,16)`)}'`,
        "-frames:v", "1",
        tilePath,
      ],
    },
    {
      label: `ticker (${ticker.w}x${ticker.h} @ ${TICKER_SHIFT_PX}px/frame)`,
      args: [
        "-loop", "1",
        // Without this the input runs at 25fps and `n` stops tracking output
        // frames. See the header.
        "-framerate", `${profile.fps}`,
        "-i", tilePath,
        "-filter_complex",
        // `split` + `hstack`, NOT `tile=2x1`.
        //
        // `tile` is a temporal-to-spatial filter: it consumes N *input frames*
        // to build one output frame, so `tile=2x1` silently halves the frame
        // rate. Built that way the ticker ran at 15fps in a 30fps project and
        // advanced only every other frame — which made adjacent output frames
        // identical and left the alignment search unable to tell frame N from
        // N+1. It looked correct in a still and was useless in motion.
        //
        // `hstack` takes one frame from each of two *streams* per output frame,
        // and `split` makes those two streams the same image, so the rate is
        // preserved and the result is the tile duplicated side by side. The
        // duplication is what makes the crop wrap seamless at `ticker.w`.
        `[0:v]split=2[a][b];[a][b]hstack=inputs=2[w];` +
        `[w]crop=w=${ticker.w}:h=${ticker.h}` +
        `:x='${esc(`mod(n*${TICKER_SHIFT_PX},${ticker.w})`)}':y=0,format=gray[o]`,
        "-map", "[o]",
        "-t", `${profile.durationSec}`,
        // crf 15 rather than 0: the pattern only has to stay sharp enough to
        // decorrelate under a shift, and lossless costs 27x the bytes.
        "-c:v", "libx264", "-crf", "15", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        ...BT709,
        outPath,
      ],
    },
  ];
}

/** Eight known colours, as a lossless PNG. */
export function swatchJob(profile, outPath) {
  const { swatch } = regionsFor(profile);
  const boxes = SWATCH_COLORS.map((c, i) => {
    const hex = c.rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
    return `drawbox=x=${i * swatch.patchW}:y=0:w=${swatch.patchW}:h=${swatch.h}` +
      `:color=0x${hex}:t=fill`;
  }).join(",");

  return {
    label: `swatch (${swatch.w}x${swatch.h})`,
    args: [
      "-f", "lavfi",
      "-i", `color=c=black:s=${swatch.w}x${swatch.h}:d=1,${boxes}`,
      "-frames:v", "1",
      // rgb24 keeps the authored values exact; the canary compares against them
      // absolutely, so a colour that is already off by a code here would spend
      // part of the tolerance before the export even starts.
      "-pix_fmt", "rgb24",
      outPath,
    ],
  };
}

/**
 * The block the animation carrier moves.
 *
 * An image rather than a shape, and that is not a style choice: `shape` and
 * `effect` are the two filetypes whose `animatableProperties` is `["opacity"]`
 * alone, so a shape cannot carry a position keyframe at all — the app refuses
 * with "A shape clip cannot animate position". An image animates all four.
 *
 * A flat saturated colour so its centroid can be recovered from a composited
 * frame without any thresholding subtlety.
 */
export function carrierBlockJob(profile, outPath) {
  const size = Math.max(8, Math.round(profile.width / 80));
  return {
    label: `carrier block (${size}x${size})`,
    args: [
      "-f", "lavfi",
      "-i", `color=c=0x00ff88:s=${size}x${size}:d=1`,
      "-frames:v", "1",
      "-pix_fmt", "rgb24",
      outPath,
    ],
  };
}

/** Seconds between sync events. */
export const SYNC_PERIOD_SEC = 2;

/**
 * The A/V sync pair: a white flash and a 2 kHz click on the same frames.
 *
 * Both are derived from the same `SYNC_PERIOD_SEC` grid in the same function,
 * which is the point — it makes "the click and the flash happen together" a
 * fact about how the fixture was built rather than an assumption about how two
 * timeline elements were placed.
 */
export function syncJobs(profile, videoOut, audioOut) {
  // Through `even`: a sixth of 640 is 106.67, and libx264 refuses an odd width
  // outright. Every other instrument already goes through it; this one was
  // missed, and only a profile whose frame is not a multiple of twelve shows it.
  const flashW = even(Math.max(64, profile.width / 6));
  const flashH = even(Math.max(64, profile.height / 6));
  const framePeriod = SYNC_PERIOD_SEC * profile.fps;

  return [
    {
      label: `sync flash (${flashW}x${flashH}, every ${SYNC_PERIOD_SEC}s)`,
      args: [
        "-f", "lavfi",
        "-i",
        `color=c=black:s=${flashW}x${flashH}:r=${profile.fps}:d=${profile.durationSec},` +
        `drawbox=x=0:y=0:w=${flashW}:h=${flashH}:color=white:t=fill` +
        `:enable='${esc(`lt(mod(n,${framePeriod}),1)`)}'`,
        "-c:v", "libx264", "-crf", "0", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        ...BT709,
        videoOut,
      ],
    },
    {
      label: `sync click (2kHz, every ${SYNC_PERIOD_SEC}s)`,
      args: [
        "-f", "lavfi",
        "-i",
        `sine=frequency=2000:sample_rate=48000:duration=${profile.durationSec},` +
        // One frame wide, so the click's centre of energy sits on the frame the
        // flash is on rather than smeared either side of it.
        `volume=enable='${esc(`lt(mod(t,${SYNC_PERIOD_SEC}),${1 / profile.fps})`)}':volume=1:eval=frame,` +
        `volume=enable='${esc(`gte(mod(t,${SYNC_PERIOD_SEC}),${1 / profile.fps})`)}':volume=0:eval=frame`,
        "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "1",
        audioOut,
      ],
    },
  ];
}

export { regionsFor, frameCount };
