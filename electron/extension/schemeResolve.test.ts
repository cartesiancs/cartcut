import path from "path";
import { describe, expect, it } from "vitest";

import {
  EXTENSION_CSP,
  EXTENSION_SCHEME,
  extensionResponseHeaders,
  resolveExtensionRequest,
} from "./schemeResolve";

const DIR = path.resolve("/ext/acme.hello");
const dirFor = (id: string) => (id === "acme.hello" ? DIR : null);

const url = (rest: string) => EXTENSION_SCHEME + "://" + rest;

describe("resolveExtensionRequest", () => {
  it("serves a file inside the extension", () => {
    expect(resolveExtensionRequest(url("acme.hello/views/panel.html"), dirFor)).toEqual({
      file: path.join(DIR, "views", "panel.html"),
      mime: "text/html; charset=utf-8",
      extId: "acme.hello",
    });
  });

  it("refuses an extension that is not loaded", () => {
    // This is also what stops a panel that was open when an extension was
    // disabled from carrying on reading its files.
    expect(resolveExtensionRequest(url("someone.else/views/panel.html"), dirFor)).toBeNull();
  });

  it("refuses a host that is not an extension id", () => {
    expect(resolveExtensionRequest(url("../../etc/panel.html"), dirFor)).toBeNull();
    expect(resolveExtensionRequest(url("Acme.Hello/views/panel.html"), dirFor)).toBeNull();
  });

  it("decodes before it checks, so a percent-encoded traversal is caught", () => {
    // `%2e%2e%2f` is `../`. A containment check run on the encoded form passes
    // it happily, which is the classic version of this bug.
    expect(resolveExtensionRequest(url("acme.hello/%2e%2e%2f%2e%2e%2fsecrets.txt"), dirFor)).toBeNull();
  });

  it("refuses a traversal spelled plainly", () => {
    expect(resolveExtensionRequest(url("acme.hello/../../../etc/passwd"), dirFor)).toBeNull();
  });

  it("refuses a bare directory request", () => {
    expect(resolveExtensionRequest(url("acme.hello/"), dirFor)).toBeNull();
  });

  it("refuses a type that is not on the table", () => {
    // Absent is a 404, never `application/octet-stream`. A `.node` or a `.sh`
    // served from a page's own origin is a file the page can hand somewhere
    // else with our headers on it.
    expect(resolveExtensionRequest(url("acme.hello/native.node"), dirFor)).toBeNull();
    expect(resolveExtensionRequest(url("acme.hello/run.sh"), dirFor)).toBeNull();
    expect(resolveExtensionRequest(url("acme.hello/package.json"), dirFor)).not.toBeNull();
  });

  it("refuses another scheme entirely", () => {
    expect(resolveExtensionRequest("file:///etc/passwd", dirFor)).toBeNull();
    expect(resolveExtensionRequest("https://example.com/x.html", dirFor)).toBeNull();
  });

  it("refuses a string that is not a URL", () => {
    expect(resolveExtensionRequest("not a url", dirFor)).toBeNull();
  });
});

describe("extensionResponseHeaders", () => {
  it("carries the CSP and refuses sniffing", () => {
    const headers = extensionResponseHeaders("text/html; charset=utf-8");
    expect(headers["content-security-policy"]).toBe(EXTENSION_CSP);
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  it("gives a view no network of its own", () => {
    // Anything a panel needs from outside goes through its extension, where
    // the `net` permission was disclosed and can be revoked.
    expect(EXTENSION_CSP).toContain("connect-src 'none'");
    expect(EXTENSION_CSP).toContain("default-src 'none'");
    expect(EXTENSION_CSP).toContain("frame-src 'none'");
  });
});
