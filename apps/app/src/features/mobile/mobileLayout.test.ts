import { describe, expect, it } from "vitest";
import {
  MOBILE_MAX_SHORT_SIDE,
  wantsMobileLayout,
  wantsTouchBridge,
  type LayoutProbe,
} from "./mobileLayout";

const phone: LayoutProbe = {
  env: "demo",
  coarsePointer: true,
  touchCapable: true,
  width: 390,
  height: 844,
  search: "",
};
const desktop: LayoutProbe = {
  env: "demo",
  coarsePointer: false,
  touchCapable: false,
  width: 1440,
  height: 900,
  search: "",
};

describe("wantsMobileLayout", () => {
  it("lays a phone out for a phone, in either orientation", () => {
    expect(wantsMobileLayout(phone)).toBe(true);
    expect(wantsMobileLayout({ ...phone, width: 844, height: 390 })).toBe(true);
  });

  it("keeps the desktop layout for a mouse, however narrow the window", () => {
    expect(wantsMobileLayout(desktop)).toBe(false);
    expect(wantsMobileLayout({ ...desktop, width: 360 })).toBe(false);
  });

  it("keeps a large tablet on the desktop layout", () => {
    expect(
      wantsMobileLayout({
        ...phone,
        width: 1024,
        height: MOBILE_MAX_SHORT_SIDE + 1,
      }),
    ).toBe(false);
  });

  it("never applies to the Electron app, even when forced", () => {
    expect(wantsMobileLayout({ ...phone, env: "electron" })).toBe(false);
    expect(
      wantsMobileLayout({ ...phone, env: "electron", search: "?mobile=1" }),
    ).toBe(false);
  });

  it("honours ?mobile= both ways", () => {
    expect(wantsMobileLayout({ ...desktop, search: "?mobile=1" })).toBe(true);
    expect(wantsMobileLayout({ ...phone, search: "?a=b&mobile=0" })).toBe(false);
    expect(wantsMobileLayout({ ...phone, search: "?mobile=maybe" })).toBe(true);
  });
});

describe("wantsTouchBridge", () => {
  it("is on for any touch-capable web page and off for Electron", () => {
    expect(wantsTouchBridge({ ...desktop, touchCapable: true })).toBe(true);
    expect(wantsTouchBridge(desktop)).toBe(false);
    expect(wantsTouchBridge({ ...phone, env: "electron" })).toBe(false);
  });

  it("is on whenever the mobile layout is forced", () => {
    expect(wantsTouchBridge({ ...desktop, search: "?mobile=1" })).toBe(true);
  });
});
