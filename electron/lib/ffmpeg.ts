/**
 * Where the FFmpeg binaries are, on this machine, for this architecture.
 *
 * Every spawn site in the app reads `FFMPEG_PATH`/`FFPROBE_PATH` from here —
 * `render/framePipe.ts`, `render/renderMain.ts`, `server/controllers/render.ts`
 * and `mcp/transcribe.ts` — so this is the only file that has to know how the
 * binaries are laid out.
 *
 * The two modes see **different shapes**, which is the one thing to get right:
 *
 *   - In the repo, `bin/` holds every target at once, one directory per
 *     platform-arch pair, because a checkout has to be able to build for all of
 *     them.
 *   - In a packaged app there is only ever one target, and electron-builder's
 *     `extraResources` copies `bin/${platform}-${arch}` *flat* into
 *     `resources/bin`. See `package.json`.
 *
 * Shipping the wrong one is not a crash — it is a silent Rosetta translation on
 * Apple Silicon, which is roughly half the export speed with nothing anywhere
 * to say so. That is what this split exists to prevent.
 */

import path from "path";
import isDev from "electron-is-dev";
import config from "../config.json";

/** The key `config.json` files its download URLs under, e.g. `darwin-arm64`. */
const TARGET = `${process.platform}-${process.arch}`;

const resourcesPath = isDev == true ? "." : process.resourcesPath;

const FFMPEG_BIN_PATH = isDev
  ? path.join(resourcesPath, "bin", TARGET)
  : path.join(resourcesPath, "bin");

/**
 * Falls back to the host platform's other architecture rather than throwing.
 *
 * A missing entry means an unbuilt target, and the filenames only ever differ
 * by the `.exe` suffix — so guessing from the platform is both safe and more
 * useful than crashing during module load, before any window exists to show an
 * error in.
 */
const target = config.ffmpegBin[TARGET] ?? {
  ffmpeg: { filename: process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg" },
  ffprobe: {
    filename: process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
  },
};

const FFMPEG_FILENAME = `${target.ffmpeg.filename}`;
const FFPROBE_FILENAME = `${target.ffprobe.filename}`;

const FFMPEG_PATH = path.join(FFMPEG_BIN_PATH, FFMPEG_FILENAME);
const FFPROBE_PATH = path.join(FFMPEG_BIN_PATH, FFPROBE_FILENAME);

const ffmpegConfig = {
  /** `platform-arch`, the key into `config.json`'s `ffmpegBin`. */
  TARGET: TARGET,

  FFMPEG_BIN_PATH: FFMPEG_BIN_PATH,
  FFMPEG_FILENAME: FFMPEG_FILENAME,
  FFPROBE_FILENAME: FFPROBE_FILENAME,

  FFMPEG_PATH: FFMPEG_PATH,
  FFPROBE_PATH: FFPROBE_PATH,
};

export { ffmpegConfig };
