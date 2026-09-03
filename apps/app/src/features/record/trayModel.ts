/**
 * The recorder's tray menu, as data.
 *
 * The menu is the recorder's entire interface — there is no window to put a
 * settings panel in, because a window would be one more thing on screen while
 * the screen is being recorded. So every setting is a row here, and this module
 * is where the settings schema meets the menu.
 *
 * It lives on the renderer side of the boundary rather than in `electron/`
 * because it reads `recordSettings.ts`, and `electron/` may not import
 * `apps/app/src` (widening `.tsconfig`'s `rootDir` relocates the main-process
 * build out of `main/`). Main receives the finished model and renders it with
 * `Menu.buildFromTemplate` — `electron/lib/recordTrayMenu.ts` states the shape
 * from its side and explains why that duplication is the stable one.
 *
 * Ids are the whole protocol between the two halves. `parseTrayId` is their
 * only reader, so a new setting is a new id spelled in two places in this one
 * file and nowhere else.
 *
 * Pure, DOM-free.
 */

import {
  BUBBLE_CORNERS,
  BUBBLE_SHAPES,
  BUBBLE_SIZES,
  QUALITY_PRESETS,
  RECORD_FPS_PRESETS,
  resolveSelection,
  systemAudioSupported,
  ZOOM_STRENGTHS,
  type RecordSettings,
} from "./recordSettings";

export type TrayItem =
  | { type: "separator" }
  | {
      type: "normal" | "checkbox" | "radio";
      id: string;
      label: string;
      checked?: boolean;
      enabled?: boolean;
      toolTip?: string;
    }
  | {
      type: "submenu";
      label: string;
      enabled?: boolean;
      toolTip?: string;
      items: TrayItem[];
    };

export type TrayModel = { tooltip: string; items: TrayItem[] };

export type MediaDevice = { deviceId: string; label: string };
export type ScreenSource = { id: string; name: string };

/**
 * Where the session is.
 *
 * `"processing"` is its own state rather than a flag on `"idle"`: the composite
 * pass takes real time on a long take, and a menu that says "Start Recording"
 * while the last one is still being written invites a second session that would
 * fight it for the encoder.
 */
export type RecorderState = "idle" | "recording" | "paused" | "processing";

export type TrayInput = {
  settings: RecordSettings;
  state: RecorderState;
  screens: readonly ScreenSource[];
  cameras: readonly MediaDevice[];
  microphones: readonly MediaDevice[];
  /** `process.platform`, forwarded from main. */
  platform: string;
};

const NONE = "";

/** Human-readable names for the settings that have them. */
const QUALITY_LABELS: Record<(typeof QUALITY_PRESETS)[number], string> = {
  "720p": "720p",
  "1080p": "1080p",
  native: "Native (sharpest)",
};

const ZOOM_LABELS: Record<(typeof ZOOM_STRENGTHS)[number], string> = {
  off: "Off",
  subtle: "Subtle",
  strong: "Strong",
};

const SIZE_LABELS: Record<(typeof BUBBLE_SIZES)[number], string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

const CORNER_LABELS: Record<(typeof BUBBLE_CORNERS)[number], string> = {
  "top-left": "Top Left",
  "top-right": "Top Right",
  "bottom-left": "Bottom Left",
  "bottom-right": "Bottom Right",
};

const SHAPE_LABELS: Record<(typeof BUBBLE_SHAPES)[number], string> = {
  circle: "Circle",
  rounded: "Rounded Rectangle",
};

/**
 * A device's name, or something usable when it has none.
 *
 * macOS reports every `MediaDeviceInfo.label` as an empty string until the
 * user has granted access to that kind of device at least once. The engine
 * re-enumerates after its first successful `getUserMedia` for exactly this
 * reason, but the menu still has to be buildable before that happens — and
 * three rows all labelled "" is a menu nobody can choose from.
 */
export function deviceLabel(
  device: MediaDevice,
  index: number,
  kind: string,
): string {
  const label = device.label.trim();
  return label.length > 0 ? label : `${kind} ${index + 1}`;
}

/**
 * The three device choices, resolved against what is present right now.
 *
 * The engine calls this before configuring its captures and the menu calls it
 * before ticking its radio groups, so what the menu says is being recorded is
 * what is being recorded. Returns a patch rather than whole settings: the
 * stored preference is not overwritten just because a device is unplugged, so
 * plugging it back in restores the choice.
 */
export function resolveRecordSelection(input: {
  settings: RecordSettings;
  screens: readonly ScreenSource[];
  cameras: readonly MediaDevice[];
  microphones: readonly MediaDevice[];
}): Pick<
  RecordSettings,
  "screenSourceId" | "cameraDeviceId" | "micDeviceId"
> {
  return {
    screenSourceId: resolveSelection(
      input.settings.screenSourceId,
      input.screens.map((screen) => screen.id),
      "first",
    ),
    cameraDeviceId: resolveSelection(
      input.settings.cameraDeviceId,
      input.cameras.map((device) => device.deviceId),
      "none",
    ),
    micDeviceId: resolveSelection(
      input.settings.micDeviceId,
      input.microphones.map((device) => device.deviceId),
      "none",
    ),
  };
}

function radioList(
  prefix: string,
  entries: readonly { id: string; label: string }[],
  selected: string,
): TrayItem[] {
  return entries.map((entry) => ({
    type: "radio" as const,
    id: `${prefix}:${entry.id}`,
    label: entry.label,
    checked: entry.id === selected,
  }));
}

export function buildTrayModel(input: TrayInput): TrayModel {
  const { settings, state } = input;
  const busy = state === "recording" || state === "paused";
  const processing = state === "processing";

  // Nothing about *what* is captured may change once capture has begun: the
  // encoders are configured from these values and are already running.
  const settable = !busy && !processing;

  const items: TrayItem[] = [];

  if (state === "idle") {
    items.push({
      type: "normal",
      id: "start",
      label: "Start Recording",
      enabled: input.screens.length > 0,
      toolTip:
        input.screens.length > 0
          ? undefined
          : "No screen is available to capture. Check Screen Recording permission for Cartcut.",
    });
  } else if (processing) {
    items.push({
      type: "normal",
      id: "noop",
      label: "Finishing the recording…",
      enabled: false,
    });
  } else {
    items.push({ type: "normal", id: "stop", label: "Stop Recording" });
    items.push({
      type: "normal",
      id: state === "paused" ? "resume" : "pause",
      label: state === "paused" ? "Resume" : "Pause",
    });
    items.push({ type: "normal", id: "cancel", label: "Discard Recording" });
  }

  items.push({ type: "separator" });

  // Checked against what will *actually* be captured, not against what is
  // stored. A `desktopCapturer` id does not survive a restart, so on the first
  // menu of every session the stored screen is a stale string — and a radio
  // group with nothing checked is a menu that cannot say what it is about to
  // record. `resolveSelection` is the same rule the engine starts the capture
  // with, so the tick and the recording cannot disagree.
  const selection = resolveRecordSelection(input);

  items.push({
    type: "submenu",
    label: "Screen",
    enabled: settable,
    items: radioList(
      "screen",
      input.screens.map((screen) => ({ id: screen.id, label: screen.name })),
      selection.screenSourceId,
    ),
  });

  items.push({
    type: "submenu",
    label: "Camera",
    enabled: settable,
    items: radioList(
      "camera",
      [
        { id: NONE, label: "None" },
        ...input.cameras.map((device, index) => ({
          id: device.deviceId,
          label: deviceLabel(device, index, "Camera"),
        })),
      ],
      selection.cameraDeviceId,
    ),
  });

  items.push({
    type: "submenu",
    label: "Microphone",
    enabled: settable,
    items: radioList(
      "mic",
      [
        { id: NONE, label: "None" },
        ...input.microphones.map((device, index) => ({
          id: device.deviceId,
          label: deviceLabel(device, index, "Microphone"),
        })),
      ],
      selection.micDeviceId,
    ),
  });

  const systemAudio = systemAudioSupported(input.platform);
  items.push({
    type: "checkbox",
    id: "systemAudio",
    label: "System Audio",
    checked: settings.systemAudio && systemAudio,
    enabled: settable && systemAudio,
    // The item is greyed rather than hidden, so "why can't I record the system
    // sound" has an answer on screen instead of being absent.
    toolTip: systemAudio
      ? undefined
      : "Capturing system audio is only available on Windows.",
  });

  items.push({ type: "separator" });

  items.push({
    type: "submenu",
    label: "Bubble",
    enabled: settable,
    items: [
      ...radioList(
        "bubbleSize",
        BUBBLE_SIZES.map((size) => ({ id: size, label: SIZE_LABELS[size] })),
        settings.bubbleSize,
      ),
      { type: "separator" },
      ...radioList(
        "bubbleCorner",
        BUBBLE_CORNERS.map((corner) => ({
          id: corner,
          label: CORNER_LABELS[corner],
        })),
        settings.bubbleCorner,
      ),
      { type: "separator" },
      ...radioList(
        "bubbleShape",
        BUBBLE_SHAPES.map((shape) => ({
          id: shape,
          label: SHAPE_LABELS[shape],
        })),
        settings.bubbleShape,
      ),
    ],
  });

  items.push({
    type: "submenu",
    label: "Quality",
    enabled: settable,
    items: [
      ...radioList(
        "quality",
        QUALITY_PRESETS.map((preset) => ({
          id: preset,
          label: QUALITY_LABELS[preset],
        })),
        settings.quality,
      ),
      { type: "separator" },
      ...radioList(
        "fps",
        RECORD_FPS_PRESETS.map((fps) => ({
          id: String(fps),
          label: `${fps} fps`,
        })),
        String(settings.fps),
      ),
    ],
  });

  items.push({
    type: "submenu",
    label: "Auto Zoom",
    enabled: settable,
    items: radioList(
      "zoom",
      ZOOM_STRENGTHS.map((strength) => ({
        id: strength,
        label: ZOOM_LABELS[strength],
      })),
      settings.autoZoom,
    ),
  });

  // Drawing is the one setting that may be changed mid-take: it is the point of
  // it. Toggling it takes the overlay out of click-through, so the pointer
  // draws instead of reaching the app underneath.
  items.push({
    type: "checkbox",
    id: "drawing",
    label: "Drawing Mode",
    checked: settings.drawing,
    enabled: !processing,
  });

  items.push({
    type: "checkbox",
    id: "clickHighlight",
    label: "Highlight Clicks",
    checked: settings.clickHighlight,
    enabled: settable,
  });

  items.push({ type: "separator" });
  items.push({
    type: "normal",
    id: "openFolder",
    label: "Open Recordings Folder",
  });
  items.push({
    type: "normal",
    id: "quit",
    label: "Close Recorder",
    enabled: !busy,
    toolTip: busy ? "Stop the recording first." : undefined,
  });

  return {
    tooltip:
      state === "recording"
        ? "Cartcut — recording"
        : state === "paused"
          ? "Cartcut — paused"
          : "Cartcut Recorder",
    items,
  };
}

/** The three settings that are checkboxes rather than radio groups. */
export type ToggleKey = "systemAudio" | "drawing" | "clickHighlight";

const TOGGLE_KEYS: readonly ToggleKey[] = [
  "systemAudio",
  "drawing",
  "clickHighlight",
];

export type TrayAction =
  | { kind: "command"; command: string }
  | { kind: "toggle"; key: ToggleKey }
  | { kind: "setting"; key: keyof RecordSettings; value: string };

/** Menu id prefix -> the settings field it writes. */
const SETTING_KEYS: Record<string, keyof RecordSettings> = {
  screen: "screenSourceId",
  camera: "cameraDeviceId",
  mic: "micDeviceId",
  quality: "quality",
  fps: "fps",
  bubbleSize: "bubbleSize",
  bubbleCorner: "bubbleCorner",
  bubbleShape: "bubbleShape",
  zoom: "autoZoom",
};

/**
 * Read a click back.
 *
 * Returns `null` for anything unrecognised rather than throwing: the ids come
 * over IPC from the main process, and a menu left on screen by an older build
 * should produce a no-op, not an exception in the middle of a recording.
 *
 * The value stays a string. Deciding that `"native"` is a real preset is
 * `applyRecordSettings`'s job — it is the write guard, and two places that
 * validate is how they come to disagree.
 */
export function parseTrayId(id: string): TrayAction | null {
  if (id.length === 0) {
    return null;
  }

  const separator = id.indexOf(":");

  if (separator === -1) {
    return (TOGGLE_KEYS as readonly string[]).includes(id)
      ? { kind: "toggle", key: id as ToggleKey }
      : { kind: "command", command: id };
  }

  const key = SETTING_KEYS[id.slice(0, separator)];

  return key == null
    ? null
    : { kind: "setting", key, value: id.slice(separator + 1) };
}

/**
 * A click as a patch for `applyRecordSettings`, or `null` if it was not one.
 *
 * The one place a menu id becomes a typed value. `fps` is the only field whose
 * id is not already its own type, and converting it here rather than in the
 * write guard keeps `applyRecordSettings` a validator rather than a parser —
 * it rejects `Number.NaN` from a malformed id exactly as it would reject a bad
 * value from anywhere else.
 */
export function settingsPatch(
  action: TrayAction,
  settings: RecordSettings,
): Partial<RecordSettings> | null {
  if (action.kind === "toggle") {
    return { [action.key]: !settings[action.key] } as Partial<RecordSettings>;
  }

  if (action.kind !== "setting") {
    return null;
  }

  if (action.key === "fps") {
    return { fps: Number(action.value) };
  }

  return { [action.key]: action.value } as Partial<RecordSettings>;
}
