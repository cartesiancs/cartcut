/**
 * When a browser can synthesise, and what the panel says when it cannot.
 *
 * Each sentence names the thing the user can change. Cache Storage and
 * SubtleCrypto both vanish outside a secure context, which is how a
 * self-hosted copy over plain HTTP looks, so that case asks for https rather
 * than blaming the browser.
 */

import { describe, expect, it } from "vitest";

import { browserTtsBlocker } from "./browserTts";

const CAPABLE = { webAssembly: true, worker: true, secureStorage: true };

describe("browserTtsBlocker", () => {
  it("lets a capable browser through", () => {
    expect(browserTtsBlocker(CAPABLE)).toBe(null);
  });

  it("asks for https when the page is not a secure context", () => {
    expect(browserTtsBlocker({ ...CAPABLE, secureStorage: false })).toContain("https");
  });

  it("names WebAssembly and the worker when those are missing", () => {
    expect(browserTtsBlocker({ ...CAPABLE, webAssembly: false })).toContain("WebAssembly");
    expect(browserTtsBlocker({ ...CAPABLE, worker: false })).toContain("worker");
  });
});
