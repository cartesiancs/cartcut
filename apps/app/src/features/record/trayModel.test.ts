import { describe, expect, it } from "vitest";

import {
  applyRecordSettings,
  DEFAULT_RECORD_SETTINGS,
  type RecordSettings,
} from "./recordSettings";
import {
  buildTrayModel,
  deviceLabel,
  parseTrayId,
  settingsPatch,
  type TrayInput,
  type TrayItem,
  type TrayModel,
} from "./trayModel";

const INPUT: TrayInput = {
  settings: DEFAULT_RECORD_SETTINGS,
  state: "idle",
  screens: [
    { id: "screen:0", name: "Built-in Retina Display" },
    { id: "screen:1", name: "DELL U2720Q" },
  ],
  cameras: [{ deviceId: "cam-1", label: "FaceTime HD Camera" }],
  microphones: [{ deviceId: "mic-1", label: "MacBook Pro Microphone" }],
  platform: "darwin",
};

/** Every item in the tree, flattened, so a test can look for one by id. */
function flatten(items: readonly TrayItem[]): TrayItem[] {
  return items.flatMap((item) =>
    item.type === "submenu" ? [item, ...flatten(item.items)] : [item],
  );
}

function byId(model: TrayModel, id: string): any {
  return flatten(model.items).find((item: any) => item.id === id);
}

function submenu(model: TrayModel, label: string): TrayItem[] {
  const found = model.items.find(
    (item) => item.type === "submenu" && item.label === label,
  );
  return found != null && found.type === "submenu" ? found.items : [];
}

describe("buildTrayModel", () => {
  it("offers Start when idle and Stop when recording", () => {
    expect(byId(buildTrayModel(INPUT), "start")).toBeDefined();

    const recording = buildTrayModel({ ...INPUT, state: "recording" });
    expect(byId(recording, "start")).toBeUndefined();
    expect(byId(recording, "stop")).toBeDefined();
    expect(byId(recording, "pause")).toBeDefined();
  });

  it("offers Resume rather than Pause once paused", () => {
    const paused = buildTrayModel({ ...INPUT, state: "paused" });
    expect(byId(paused, "resume")).toBeDefined();
    expect(byId(paused, "pause")).toBeUndefined();
  });

  // A menu that says "Start Recording" while the last take is still being
  // composited invites a second session to fight it for the encoder.
  it("offers nothing to start while the last take is still being written", () => {
    const processing = buildTrayModel({ ...INPUT, state: "processing" });
    expect(byId(processing, "start")).toBeUndefined();
    expect(byId(processing, "stop")).toBeUndefined();
  });

  it("cannot be started with no screen to capture, and says why", () => {
    const model = buildTrayModel({ ...INPUT, screens: [] });
    const start = byId(model, "start");

    expect(start.enabled).toBe(false);
    expect(start.toolTip).toMatch(/permission/i);
  });

  it("checks the selected screen and nothing else", () => {
    const settings: RecordSettings = {
      ...DEFAULT_RECORD_SETTINGS,
      screenSourceId: "screen:1",
    };
    const screens = submenu(buildTrayModel({ ...INPUT, settings }), "Screen");

    expect(screens.map((item: any) => item.checked)).toEqual([false, true]);
  });

  // A `desktopCapturer` id is minted per enumeration and does not survive a
  // restart, so the stored screen is a stale string on the first menu of every
  // session. A radio group with nothing ticked cannot say what it is about to
  // record.
  it("falls back to the first screen when the stored one is gone", () => {
    const settings: RecordSettings = {
      ...DEFAULT_RECORD_SETTINGS,
      screenSourceId: "screen:from-last-tuesday",
    };
    const screens = submenu(buildTrayModel({ ...INPUT, settings }), "Screen");

    expect(screens.map((item: any) => item.checked)).toEqual([true, false]);
  });

  // A camera that was unplugged over lunch must not be silently replaced by
  // another one: that puts a face in a recording meant to have none.
  it("falls back to None when the stored camera is gone", () => {
    const settings: RecordSettings = {
      ...DEFAULT_RECORD_SETTINGS,
      cameraDeviceId: "cam-unplugged",
    };
    const cameras = submenu(
      buildTrayModel({ ...INPUT, settings }),
      "Camera",
    ) as any[];

    expect(cameras[0]).toMatchObject({ label: "None", checked: true });
    expect(cameras[1].checked).toBe(false);
  });

  // The preference is not overwritten just because a device is missing, so
  // plugging it back in restores the choice.
  it("resolves without writing the stored preference away", () => {
    const settings: RecordSettings = {
      ...DEFAULT_RECORD_SETTINGS,
      cameraDeviceId: "cam-unplugged",
    };

    buildTrayModel({ ...INPUT, settings });
    expect(settings.cameraDeviceId).toBe("cam-unplugged");
  });

  it("gives every device list a None entry, checked when nothing is chosen", () => {
    const model = buildTrayModel(INPUT);

    for (const label of ["Camera", "Microphone"]) {
      const items = submenu(model, label) as any[];
      expect(items[0]).toMatchObject({ label: "None", checked: true });
      expect(items).toHaveLength(2);
    }
  });

  // The encoders are configured from these values and are already running.
  it("locks what is captured once capture has begun", () => {
    const recording = buildTrayModel({ ...INPUT, state: "recording" });

    for (const label of ["Screen", "Camera", "Microphone", "Quality"]) {
      const item = recording.items.find(
        (candidate) =>
          candidate.type === "submenu" && candidate.label === label,
      ) as any;
      expect(item.enabled).toBe(false);
    }
  });

  // Drawing is the one setting whose whole point is changing it mid-take.
  it("leaves drawing mode changeable while recording", () => {
    const recording = buildTrayModel({ ...INPUT, state: "recording" });
    expect(byId(recording, "drawing").enabled).toBe(true);
  });

  it("will not close the recorder out from under a running take", () => {
    expect(byId(buildTrayModel(INPUT), "quit").enabled).toBe(true);
    expect(
      byId(buildTrayModel({ ...INPUT, state: "recording" }), "quit").enabled,
    ).toBe(false);
  });

  describe("system audio", () => {
    // Greyed rather than hidden, so "why can't I record the system sound" has
    // an answer on screen instead of being absent.
    it("is disabled with a reason on macOS", () => {
      const item = byId(buildTrayModel(INPUT), "systemAudio");

      expect(item.enabled).toBe(false);
      expect(item.toolTip).toMatch(/Windows/);
    });

    it("is available on Windows", () => {
      const item = byId(
        buildTrayModel({ ...INPUT, platform: "win32" }),
        "systemAudio",
      );

      expect(item.enabled).toBe(true);
      expect(item.toolTip).toBeUndefined();
    });

    it("shows unchecked on macOS even when the preference is on", () => {
      const settings = { ...DEFAULT_RECORD_SETTINGS, systemAudio: true };
      expect(byId(buildTrayModel({ ...INPUT, settings }), "systemAudio").checked)
        .toBe(false);
      expect(
        byId(
          buildTrayModel({ ...INPUT, settings, platform: "win32" }),
          "systemAudio",
        ).checked,
      ).toBe(true);
    });
  });

  it("names the state in its tooltip", () => {
    expect(buildTrayModel(INPUT).tooltip).toBe("Cartcut Recorder");
    expect(buildTrayModel({ ...INPUT, state: "recording" }).tooltip).toMatch(
      /recording/,
    );
  });

  it("checks exactly one item in every radio group", () => {
    const model = buildTrayModel(INPUT);
    const groups = ["Screen", "Camera", "Microphone", "Auto Zoom"];

    for (const label of groups) {
      const checked = (submenu(model, label) as any[]).filter(
        (item) => item.checked === true,
      );
      expect(checked).toHaveLength(1);
    }
  });
});

describe("deviceLabel", () => {
  // macOS reports every label as "" until access has been granted once, and
  // three rows all labelled "" is a menu nobody can choose from.
  it("invents a name for an unlabelled device", () => {
    expect(deviceLabel({ deviceId: "a", label: "" }, 0, "Camera")).toBe(
      "Camera 1",
    );
    expect(deviceLabel({ deviceId: "a", label: "   " }, 2, "Microphone")).toBe(
      "Microphone 3",
    );
  });

  it("uses the real name when there is one", () => {
    expect(deviceLabel({ deviceId: "a", label: "FaceTime HD" }, 0, "Camera"))
      .toBe("FaceTime HD");
  });
});

describe("parseTrayId", () => {
  it("reads a plain command", () => {
    expect(parseTrayId("start")).toEqual({ kind: "command", command: "start" });
  });

  it("reads the three checkbox settings as toggles, not commands", () => {
    expect(parseTrayId("drawing")).toEqual({ kind: "toggle", key: "drawing" });
    expect(parseTrayId("systemAudio")).toEqual({
      kind: "toggle",
      key: "systemAudio",
    });
  });

  it("reads a prefixed id as a setting", () => {
    expect(parseTrayId("camera:cam-1")).toEqual({
      kind: "setting",
      key: "cameraDeviceId",
      value: "cam-1",
    });
  });

  // Device ids contain colons on every platform — `screen:0` is one.
  it("splits on the first colon only", () => {
    expect(parseTrayId("screen:window:12:3")).toEqual({
      kind: "setting",
      key: "screenSourceId",
      value: "window:12:3",
    });
  });

  it("reads an empty selection, which is how a source is turned off", () => {
    expect(parseTrayId("camera:")).toEqual({
      kind: "setting",
      key: "cameraDeviceId",
      value: "",
    });
  });

  // A menu left on screen by an older build should be a no-op, not a throw in
  // the middle of a recording.
  it("answers null for anything it does not know", () => {
    expect(parseTrayId("")).toBeNull();
    expect(parseTrayId("nonsense:value")).toBeNull();
  });
});

describe("settingsPatch", () => {
  it("flips a toggle against the current value", () => {
    const on = { ...DEFAULT_RECORD_SETTINGS, drawing: true };
    expect(settingsPatch({ kind: "toggle", key: "drawing" }, on)).toEqual({
      drawing: false,
    });
    expect(
      settingsPatch(
        { kind: "toggle", key: "drawing" },
        DEFAULT_RECORD_SETTINGS,
      ),
    ).toEqual({ drawing: true });
  });

  it("turns the one numeric id into a number", () => {
    expect(
      settingsPatch(
        { kind: "setting", key: "fps", value: "60" },
        DEFAULT_RECORD_SETTINGS,
      ),
    ).toEqual({ fps: 60 });
  });

  it("passes every other value through as the string it already is", () => {
    expect(
      settingsPatch(
        { kind: "setting", key: "quality", value: "1080p" },
        DEFAULT_RECORD_SETTINGS,
      ),
    ).toEqual({ quality: "1080p" });
  });

  it("has nothing to say about a command", () => {
    expect(
      settingsPatch({ kind: "command", command: "stop" }, DEFAULT_RECORD_SETTINGS),
    ).toBeNull();
  });

  // The parser converts; the write guard validates. A malformed id becomes
  // `NaN`, which `applyRecordSettings` rejects like any other bad value.
  it("hands a malformed rate to the write guard, which declines it", () => {
    const patch = settingsPatch(
      { kind: "setting", key: "fps", value: "sixty" },
      DEFAULT_RECORD_SETTINGS,
    )!;

    expect(Number.isNaN(patch.fps)).toBe(true);
    expect(applyRecordSettings(DEFAULT_RECORD_SETTINGS, patch)).toBe(
      DEFAULT_RECORD_SETTINGS,
    );
  });

  // The round trip the engine actually runs, end to end.
  it("carries a real click through to a changed setting", () => {
    const action = parseTrayId("quality:720p")!;
    const patch = settingsPatch(action, DEFAULT_RECORD_SETTINGS)!;

    expect(applyRecordSettings(DEFAULT_RECORD_SETTINGS, patch).quality).toBe(
      "720p",
    );
  });
});
