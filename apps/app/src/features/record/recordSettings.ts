/**
 * What the recorder is set to capture.
 *
 * One object, persisted whole under the `record` key in `electron-store`, read
 * by the engine renderer and rendered as a tray menu by the main process.
 *
 * It lives here rather than in `electron/` for two reasons. `electron/` may not
 * import `apps/app/src` — `.tsconfig`'s `rootDir` widens and the whole build
 * relocates out of `main/` (see CLAUDE.md) — and this module is pure
 * arithmetic over plain data, so it belongs where vitest can reach it.
 * `vitest.config.ts` includes `apps/app/src/**` and `electron/**` and nothing
 * else. The main process therefore treats the settings object as opaque JSON:
 * it stores it, forwards it, and builds its menu from a *model* the engine
 * sends up. No settings rule is written twice.
 *
 * The read/write split is the one `frames.ts` states for `fps` and every module
 * in this codebase follows:
 *
 *  - **`normalizeRecordSettings` guards reads.** It runs on anything that comes
 *    back from disk — including a file written by an older build, or by hand —
 *    and must never throw. Anything it cannot understand becomes the default.
 *  - **`applyRecordSettings` validates writes.** It runs once, where a value is
 *    stored, so an unusable setting is unrepresentable from then on.
 *
 * `applyRecordSettings` returns **its input, by identity**, when a patch changes
 * nothing. That is the same decline contract the timeline's pure ops have, and
 * it is what lets the tray skip rebuilding its menu on a click that re-selects
 * what was already selected.
 *
 * DOM-free.
 */

/** Where the camera bubble sits in the finished picture. */
export const BUBBLE_CORNERS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export type BubbleCorner = (typeof BUBBLE_CORNERS)[number];

/** A circle, or a rounded rectangle at the camera's own aspect. */
export const BUBBLE_SHAPES = ["circle", "rounded"] as const;
export type BubbleShape = (typeof BUBBLE_SHAPES)[number];

export const BUBBLE_SIZES = ["small", "medium", "large"] as const;
export type BubbleSize = (typeof BUBBLE_SIZES)[number];

/**
 * How hard the auto-zoom pushes.
 *
 * `"off"` is a value rather than a `null` because the tray shows it as one of
 * three radio items, and a tri-state that is sometimes absent is a menu that
 * sometimes has nothing checked.
 */
export const ZOOM_STRENGTHS = ["off", "subtle", "strong"] as const;
export type ZoomStrength = (typeof ZOOM_STRENGTHS)[number];

/**
 * The capture size, named.
 *
 * `"native"` means the display's own pixel count — `size × scaleFactor` — which
 * is the setting that matters most for legible text and the one the in-panel
 * recorder gets wrong by clamping to 1920×1080. The two fixed heights exist for
 * a long take on a small disk.
 */
export const QUALITY_PRESETS = ["720p", "1080p", "native"] as const;
export type QualityPreset = (typeof QUALITY_PRESETS)[number];

/** The rates the tray offers by name. Any integer in range is still accepted. */
export const RECORD_FPS_PRESETS = [15, 30, 60] as const;

export const MIN_RECORD_FPS = 1;

/**
 * Fastest capture rate.
 *
 * Not `frames.ts#MAX_FPS`, which is 240 and is about what a *project* may run
 * at. A desktop capture above 60 costs bandwidth the encoder spends better on
 * spatial detail — `contentHint = "detail"` says the same thing to Chromium —
 * and no display this ships to refreshes faster.
 */
export const MAX_RECORD_FPS = 60;

export type RecordSettings = {
  /** A `desktopCapturer` source id. Empty until a screen has been chosen. */
  screenSourceId: string;
  /** A `MediaDeviceInfo.deviceId`, or empty for "no camera". */
  cameraDeviceId: string;
  /** A `MediaDeviceInfo.deviceId`, or empty for "no microphone". */
  micDeviceId: string;
  /**
   * Capture the system's own output alongside the microphone.
   *
   * Only ever true on Windows: Electron 33's `Streams.audio` documents
   * `loopback` as Windows-only, and `systemAudioSupported` is what the tray
   * greys the item out by. Stored regardless so the preference survives a move
   * between machines.
   */
  systemAudio: boolean;
  quality: QualityPreset;
  fps: number;
  bubbleCorner: BubbleCorner;
  bubbleShape: BubbleShape;
  bubbleSize: BubbleSize;
  autoZoom: ZoomStrength;
  /** The overlay stops being click-through and takes the pen. */
  drawing: boolean;
  /** Needs a global mouse hook, so it is off until one is installed. */
  clickHighlight: boolean;
};

export const DEFAULT_RECORD_SETTINGS: RecordSettings = {
  screenSourceId: "",
  cameraDeviceId: "",
  micDeviceId: "",
  systemAudio: false,
  quality: "native",
  fps: 30,
  bubbleCorner: "bottom-left",
  bubbleShape: "circle",
  bubbleSize: "medium",
  autoZoom: "subtle",
  drawing: false,
  clickHighlight: false,
};

function oneOf<T extends string>(
  values: readonly T[],
  raw: unknown,
  fallback: T,
): T {
  return typeof raw === "string" && (values as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

function asString(raw: unknown, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

function asBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Whole frames per second, in range.
 *
 * Integers only, for the reason `frames.ts` gives: the NTSC family is
 * `30000/1001` and its relatives, and a capture rate that cannot be named
 * exactly is one the muxer's timescale and the editor's frame grid will
 * disagree about.
 */
export function normalizeRecordFps(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_RECORD_SETTINGS.fps;
  }
  const whole = Math.round(raw);
  if (whole < MIN_RECORD_FPS || whole > MAX_RECORD_FPS) {
    return DEFAULT_RECORD_SETTINGS.fps;
  }
  return whole;
}

/**
 * Read whatever is on disk as settings. Never throws.
 *
 * Absent means default, field by field — which is what lets a new setting ship
 * without a version bump, the same rule the project file follows for a new
 * element field.
 */
export function normalizeRecordSettings(raw: unknown): RecordSettings {
  const source = (raw ?? {}) as Partial<Record<keyof RecordSettings, unknown>>;
  const d = DEFAULT_RECORD_SETTINGS;

  return {
    screenSourceId: asString(source.screenSourceId, d.screenSourceId),
    cameraDeviceId: asString(source.cameraDeviceId, d.cameraDeviceId),
    micDeviceId: asString(source.micDeviceId, d.micDeviceId),
    systemAudio: asBoolean(source.systemAudio, d.systemAudio),
    quality: oneOf(QUALITY_PRESETS, source.quality, d.quality),
    fps: normalizeRecordFps(source.fps),
    bubbleCorner: oneOf(BUBBLE_CORNERS, source.bubbleCorner, d.bubbleCorner),
    bubbleShape: oneOf(BUBBLE_SHAPES, source.bubbleShape, d.bubbleShape),
    bubbleSize: oneOf(BUBBLE_SIZES, source.bubbleSize, d.bubbleSize),
    autoZoom: oneOf(ZOOM_STRENGTHS, source.autoZoom, d.autoZoom),
    drawing: asBoolean(source.drawing, d.drawing),
    clickHighlight: asBoolean(source.clickHighlight, d.clickHighlight),
  };
}

/**
 * Apply a patch, validating every field it touches.
 *
 * Returns `settings` **by identity** when nothing changed, so a tray click that
 * re-selects the current camera rebuilds no menu and writes no file. A field
 * whose new value is unusable is left alone rather than reset to the default —
 * a bad write should not lose a good setting.
 */
export function applyRecordSettings(
  settings: RecordSettings,
  patch: Partial<RecordSettings>,
): RecordSettings {
  const next: RecordSettings = { ...settings };
  let changed = false;

  const set = <K extends keyof RecordSettings>(
    key: K,
    value: RecordSettings[K],
  ) => {
    if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  };

  for (const key of Object.keys(patch) as (keyof RecordSettings)[]) {
    const value = patch[key];
    if (value === undefined) {
      continue;
    }

    switch (key) {
      case "screenSourceId":
      case "cameraDeviceId":
      case "micDeviceId":
        if (typeof value === "string") {
          set(key, value);
        }
        break;
      case "systemAudio":
      case "drawing":
      case "clickHighlight":
        if (typeof value === "boolean") {
          set(key, value);
        }
        break;
      case "quality":
        if ((QUALITY_PRESETS as readonly unknown[]).includes(value)) {
          set(key, value as QualityPreset);
        }
        break;
      case "fps":
        if (
          typeof value === "number" &&
          Number.isInteger(value) &&
          value >= MIN_RECORD_FPS &&
          value <= MAX_RECORD_FPS
        ) {
          set(key, value);
        }
        break;
      case "bubbleCorner":
        if ((BUBBLE_CORNERS as readonly unknown[]).includes(value)) {
          set(key, value as BubbleCorner);
        }
        break;
      case "bubbleShape":
        if ((BUBBLE_SHAPES as readonly unknown[]).includes(value)) {
          set(key, value as BubbleShape);
        }
        break;
      case "bubbleSize":
        if ((BUBBLE_SIZES as readonly unknown[]).includes(value)) {
          set(key, value as BubbleSize);
        }
        break;
      case "autoZoom":
        if ((ZOOM_STRENGTHS as readonly unknown[]).includes(value)) {
          set(key, value as ZoomStrength);
        }
        break;
    }
  }

  return changed ? next : settings;
}

/**
 * The device that will actually be used, given what is plugged in right now.
 *
 * A stored id is a *preference*, not a guarantee. `desktopCapturer` source ids
 * are minted per enumeration and do not survive a restart at all, and a camera
 * that was unplugged over lunch takes its `deviceId` with it. Reading the
 * stored value straight into a capture request is how a recorder ends up
 * capturing nothing and reporting nothing.
 *
 * `whenMissing` is the difference between the two kinds of source:
 *
 *  - `"first"` for the screen. A recording has to capture *something*, and any
 *    screen is a better answer than a failed start.
 *  - `"none"` for the camera and the microphone, where an empty string is a
 *    real choice the user may have made and silently substituting a device
 *    would put a face or a voice in a recording that was meant to have neither.
 */
export function resolveSelection(
  stored: string,
  available: readonly string[],
  whenMissing: "first" | "none",
): string {
  if (stored !== "" && available.includes(stored)) {
    return stored;
  }
  if (whenMissing === "none") {
    return "";
  }
  return available[0] ?? "";
}

/**
 * System audio is capturable on this platform.
 *
 * Electron 33 states it plainly in `Streams.audio`: "Specifying a loopback
 * device will capture system audio, and is currently only supported on
 * Windows." macOS needs ScreenCaptureKit, which arrives with a later Electron.
 * The tray greys the item rather than hiding it, so the answer to "why can't I
 * record the system sound" is on screen instead of absent.
 */
export function systemAudioSupported(platform: string): boolean {
  return platform === "win32";
}

/** What actually gets captured, once the platform has had its say. */
export function effectiveSystemAudio(
  settings: RecordSettings,
  platform: string,
): boolean {
  return settings.systemAudio && systemAudioSupported(platform);
}
