import { describe, it, expect } from "vitest";
import { createTextElement } from "../element/textElement";
import { PRESET_TEXT, presetLayout, textOptionsFor } from "./textPresetOptions";
import { buildTextPresets, presetFontFiles, type TextPreset } from "./textPresets";

const presets = buildTextPresets(
  presetFontFiles().map((file) => ({
    path: `/Resources/assets/fonts/google/${file}`,
    name: file.slice(0, file.lastIndexOf(".")),
    type: "ttf",
  })),
);
const byId = (id: string): TextPreset => {
  const preset = presets.find((p) => p.id === id);
  if (preset == null) {
    throw new Error(`no preset ${id}`);
  }
  return preset;
};

const HD = { w: 1920, h: 1080 };
const UHD = { w: 3840, h: 2160 };

describe("presetLayout", () => {
  it("sizes the type from the frame's height and centres the box", () => {
    const layout = presetLayout({}, HD);
    expect(layout.fontsize).toBe(54);
    expect(layout.width).toBe(1920);
    expect(layout.locationX).toBe(0);
    expect(layout.locationY).toBe(Math.round(540 - layout.height! / 2));
  });

  it("applies the face's size multiplier", () => {
    expect(presetLayout({ sizeScale: 1.25 }, HD).fontsize).toBe(68);
  });
});

describe("textOptionsFor", () => {
  it("adds the preset's sample text unless told otherwise", () => {
    expect(textOptionsFor(byId("Roboto-Bold/clean"), HD).text).toBe(PRESET_TEXT);
    expect(textOptionsFor(byId("Roboto-Bold/clean"), HD, "Hi").text).toBe("Hi");
  });

  it("names the font by the three fields that have to agree", () => {
    expect(textOptionsFor(byId("Anton-Regular/hot"), HD)).toMatchObject({
      fontpath: "/Resources/assets/fonts/google/Anton-Regular.ttf",
      fontname: "Anton-Regular",
      fonttype: "ttf",
    });
  });

  it("gives a 1080p project the numbers the preset states", () => {
    const options = textOptionsFor(byId("OpenSans-SemiBold/caption"), HD);
    expect(options).toMatchObject({
      backgroundEnable: true,
      backgroundColor: "#000000",
      backgroundOpacity: 60,
      backgroundPadding: 14,
      backgroundRadius: 6,
    });
    expect(textOptionsFor(byId("Bangers-Regular/comic"), HD)).toMatchObject({
      outline: { enable: true, size: 6, color: "#111111" },
      shadow: { enable: true, offsetX: 5, offsetY: 5, blur: 0, color: "#e63946", opacity: 100 },
    });
  });

  it("scales every length with the frame, and no opacity or colour", () => {
    const hd = textOptionsFor(byId("Bangers-Regular/fire"), HD);
    const uhd = textOptionsFor(byId("Bangers-Regular/fire"), UHD);
    expect(uhd.glow).toEqual({ ...hd.glow, size: hd.glow!.size * 2 });
    expect(uhd.shadow).toEqual({
      ...hd.shadow,
      offsetY: hd.shadow!.offsetY * 2,
      blur: hd.shadow!.blur * 2,
    });
    expect(uhd.fontsize).toBe(hd.fontsize! * 2);

    const tracked = textOptionsFor(byId("Raleway-SemiBold/cinema"), UHD);
    expect(tracked.letterSpacing).toBe(36);
  });

  it("scales the band's default padding too, and writes none at 1080p", () => {
    const boxedHd = textOptionsFor(byId("Roboto-Bold/boxed"), HD);
    const boxedUhd = textOptionsFor(byId("Roboto-Bold/boxed"), UHD);
    expect(boxedHd.backgroundPadding).toBe(12);
    expect(boxedUhd.backgroundPadding).toBe(24);
    expect(createTextElement(boxedHd).background).toEqual({
      enable: true,
      color: "#000000",
    });
    expect(createTextElement(boxedUhd).background.padding).toBe(24);
  });

  it("makes a recipe element at 1080p exactly what the old panel made", () => {
    // The fields the panel wrote before the designs existed, and nothing else.
    const element = createTextElement(textOptionsFor(byId("Montserrat-ExtraBold/outline"), HD));
    expect(element.options).toEqual({
      isBold: false,
      isItalic: false,
      align: "center",
      outline: { enable: true, size: 8, color: "#000000" },
    });
    expect(element.background).toEqual({ enable: false, color: "#000000" });
    expect("fill" in element).toBe(false);
    expect("textOpacity" in element).toBe(false);
  });

  it("carries a design's new fields onto the element", () => {
    const whisper = createTextElement(textOptionsFor(byId("Nunito-Bold/whisper"), HD));
    expect(whisper.options.textTransform).toBe("lowercase");
    expect(whisper.textOpacity).toBe(70);

    const soft = createTextElement(textOptionsFor(byId("Inter-Bold/softEdge"), HD));
    expect(soft.options.outline).toEqual({
      enable: true,
      size: 10,
      color: "#000000",
      opacity: 45,
    });

    const sunset = createTextElement(textOptionsFor(byId("BebasNeue-Regular/sunset"), HD));
    expect(sunset.fill).toEqual({
      type: "gradient",
      from: "#ffb347",
      to: "#ff5e62",
      angle: 0,
    });
  });
});
