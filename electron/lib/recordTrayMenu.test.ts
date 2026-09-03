import { describe, expect, it, vi } from "vitest";

import { toMenuTemplate, type TrayModel } from "./recordTrayMenu.js";

const MODEL: TrayModel = {
  tooltip: "Cartcut Recorder",
  items: [
    { type: "normal", id: "start", label: "Start Recording" },
    { type: "separator" },
    {
      type: "submenu",
      label: "Camera",
      items: [
        { type: "radio", id: "camera:", label: "None", checked: false },
        { type: "radio", id: "camera:cam-1", label: "FaceTime HD", checked: true },
      ],
    },
    {
      type: "checkbox",
      id: "systemAudio",
      label: "System Audio",
      checked: false,
      enabled: false,
      toolTip: "Only available on Windows",
    },
    { type: "submenu", label: "Microphone", items: [] },
  ],
};

describe("toMenuTemplate", () => {
  it("keeps the model's order and shape", () => {
    const template = toMenuTemplate(MODEL, () => {});

    expect(template).toHaveLength(5);
    expect(template[0]).toMatchObject({
      label: "Start Recording",
      type: "normal",
    });
    expect(template[1]).toEqual({ type: "separator" });
    expect(template[2].submenu).toHaveLength(2);
  });

  // `id` is opaque to the main process: the engine names it and the engine
  // reads it back, which is what keeps a new setting from touching this file.
  it("reports the clicked item's id, unaltered", () => {
    const onClick = vi.fn();
    const template = toMenuTemplate(MODEL, onClick);

    (template[0].click as any)();
    expect(onClick).toHaveBeenCalledWith("start");

    const camera = template[2].submenu as any[];
    camera[1].click();
    expect(onClick).toHaveBeenCalledWith("camera:cam-1");
  });

  it("carries checked state and the reason a row is disabled", () => {
    const template = toMenuTemplate(MODEL, () => {});

    expect(template[3]).toMatchObject({
      type: "checkbox",
      checked: false,
      enabled: false,
      toolTip: "Only available on Windows",
    });
  });

  it("marks radio items checked exactly as the model says", () => {
    const camera = toMenuTemplate(MODEL, () => {})[2].submenu as any[];

    expect(camera[0].checked).toBe(false);
    expect(camera[1].checked).toBe(true);
  });

  // Electron throws when a `normal` item is given `checked`, and the engine has
  // no reason to know that.
  it("never puts checked on a plain item", () => {
    const template = toMenuTemplate(MODEL, () => {});
    expect("checked" in template[0]).toBe(false);
  });

  // A device list that came back empty would otherwise open onto nothing and
  // say nothing.
  it("turns an empty submenu into a disabled row rather than an empty flyout", () => {
    const template = toMenuTemplate(MODEL, () => {});

    expect(template[4]).toMatchObject({ label: "Microphone", enabled: false });
    expect(template[4].submenu).toBeUndefined();
  });

  it("defaults an unstated enabled to true", () => {
    const template = toMenuTemplate(MODEL, () => {});
    expect(template[0].enabled).toBe(true);
    expect(template[2].enabled).toBe(true);
  });

  it("handles a model with nothing in it", () => {
    expect(toMenuTemplate({ tooltip: "", items: [] }, () => {})).toEqual([]);
  });
});
