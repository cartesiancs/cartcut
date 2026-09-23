import { describe, expect, it } from "vitest";

import { decideAttach, STRIPPED_ATTRIBUTES } from "./webviewPolicy";
import { EXTENSION_SCHEME } from "./schemeResolve";

const ENABLED = ["acme.hello"];
const PRELOAD = "/app/main/extension/webviewPreload.js";

describe("decideAttach", () => {
  it("admits a loaded extension's own page", () => {
    const decision = decideAttach(EXTENSION_SCHEME + "://acme.hello/views/panel.html", ENABLED, PRELOAD);
    expect(decision.ok).toBe(true);
  });

  it("forces the preferences that make a guest harmless", () => {
    const decision = decideAttach(EXTENSION_SCHEME + "://acme.hello/p.html", ENABLED, PRELOAD);
    if (!decision.ok) {
      throw new Error(decision.reason);
    }
    expect(decision.preferences).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      preload: PRELOAD,
      partition: "persist:ext:acme.hello",
    });
  });

  it("gives each extension its own partition", () => {
    // Otherwise two extensions share localStorage, cookies and cache, and one
    // can read what the other stored.
    const a = decideAttach(EXTENSION_SCHEME + "://acme.hello/p.html", ["acme.hello", "other.ext"], PRELOAD);
    const b = decideAttach(EXTENSION_SCHEME + "://other.ext/p.html", ["acme.hello", "other.ext"], PRELOAD);
    if (!a.ok || !b.ok) {
      throw new Error("both should attach");
    }
    expect(a.preferences.partition).not.toBe(b.preferences.partition);
  });

  it("refuses a remote page", () => {
    expect(decideAttach("https://example.com/", ENABLED, PRELOAD).ok).toBe(false);
  });

  it("refuses a file URL", () => {
    expect(decideAttach("file:///etc/passwd", ENABLED, PRELOAD).ok).toBe(false);
  });

  it("refuses an extension that is not loaded or is disabled", () => {
    expect(decideAttach(EXTENSION_SCHEME + "://ghost.ext/p.html", ENABLED, PRELOAD).ok).toBe(false);
    expect(decideAttach(EXTENSION_SCHEME + "://acme.hello/p.html", [], PRELOAD).ok).toBe(false);
  });

  it("refuses a webview with no src at all", () => {
    expect(decideAttach(undefined, ENABLED, PRELOAD).ok).toBe(false);
    expect(decideAttach("", ENABLED, PRELOAD).ok).toBe(false);
  });

  it("strips every attribute that would reopen what it just closed", () => {
    for (const attribute of ["preload", "nodeintegration", "webpreferences", "disablewebsecurity"]) {
      expect(STRIPPED_ATTRIBUTES as readonly string[]).toContain(attribute);
    }
  });

  it("never lets a guest embed a guest", () => {
    const decision = decideAttach(EXTENSION_SCHEME + "://acme.hello/p.html", ENABLED, PRELOAD);
    if (!decision.ok) {
      throw new Error(decision.reason);
    }
    expect(decision.preferences.webviewTag).toBe(false);
  });
});
