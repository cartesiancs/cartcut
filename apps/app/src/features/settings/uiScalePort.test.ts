import { describe, expect, it } from "vitest";
import {
  readUiScale,
  reflectUiScale,
  requestUiScale,
  uiScalePort,
  type UiScalePort,
} from "./uiScalePort";

function fakePort(overrides: Partial<UiScalePort> = {}): UiScalePort & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    uiScale: async () => 1.25,
    setUiScale: async (scale) => {
      asked.push(scale);
      return { ok: true, scale };
    },
    ...overrides,
  };
}

describe("uiScalePort", () => {
  it("is null with no bridge, as in the web build", () => {
    expect(uiScalePort()).toBeNull();
  });
});

describe("readUiScale", () => {
  it("answers what main has", async () => {
    expect(await readUiScale(fakePort())).toBe(1.25);
  });

  it("reads an answer that is not a choice as 100%", async () => {
    expect(await readUiScale(fakePort({ uiScale: async () => "huge" }))).toBe(1);
  });

  it("answers null with no bridge or a failed call", async () => {
    expect(await readUiScale(null)).toBeNull();
    expect(
      await readUiScale(fakePort({ uiScale: async () => Promise.reject(new Error("gone")) })),
    ).toBeNull();
  });
});

describe("requestUiScale", () => {
  it("asks main and answers the scale it applied", async () => {
    const port = fakePort();
    expect(await requestUiScale(1.5, port)).toBe(1.5);
    expect(port.asked).toEqual([1.5]);
  });

  it("answers null when main refuses", async () => {
    const port = fakePort({ setUiScale: async () => ({ ok: false }) });
    expect(await requestUiScale(2, port)).toBeNull();
  });

  it("answers null with no bridge or a failed call", async () => {
    expect(await requestUiScale(1, null)).toBeNull();
    const port = fakePort({ setUiScale: async () => Promise.reject(new Error("gone")) });
    expect(await requestUiScale(0.75, port)).toBeNull();
  });
});

describe("reflectUiScale", () => {
  it("writes the scale to --ui-scale", () => {
    const written: Record<string, string> = {};
    reflectUiScale({ style: { setProperty: (name, value) => (written[name] = value) } }, 1.75);
    expect(written).toEqual({ "--ui-scale": "1.75" });
  });
});
