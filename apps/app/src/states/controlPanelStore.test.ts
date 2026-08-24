import { beforeEach, describe, expect, it } from "vitest";
import { controlPanelStore } from "./controlPanelStore";

const reset = () =>
  controlPanelStore.setState({ active: [], nowActive: "" }, false);

const open = (panel: any) => controlPanelStore.getState().openPanel(panel);
const close = (panel: any) => controlPanelStore.getState().closePanel(panel);
const focus = (panel: any) => controlPanelStore.getState().setActivePanel(panel);
const state = () => controlPanelStore.getState();

describe("controlPanelStore", () => {
  beforeEach(reset);

  it("opens a panel and focuses it", () => {
    open("record");

    expect(state().active).toEqual(["record"]);
    expect(state().nowActive).toBe("record");
  });

  it("keeps one tab per panel however often it is opened", () => {
    open("record");
    open("audioRecord");
    open("record");
    open("record");

    expect(state().active).toEqual(["record", "audioRecord"]);
  });

  it("re-focuses an already open panel instead of adding a tab", () => {
    open("record");
    focus("");
    open("record");

    expect(state().active).toEqual(["record"]);
    expect(state().nowActive).toBe("record");
  });

  it("falls back to the preview when the focused panel closes", () => {
    open("record");
    close("record");

    expect(state().active).toEqual([]);
    expect(state().nowActive).toBe("");
  });

  it("leaves the focus alone when a background panel closes", () => {
    open("record");
    open("ytDownload");
    close("record");

    expect(state().active).toEqual(["ytDownload"]);
    expect(state().nowActive).toBe("ytDownload");
  });

  it("ignores closing a panel that is not open", () => {
    open("record");
    const before = state().active;
    close("audioRecord");

    expect(state().active).toBe(before);
    expect(state().nowActive).toBe("record");
  });
});
