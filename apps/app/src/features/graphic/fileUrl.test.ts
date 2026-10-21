import { afterEach, describe, expect, it } from "vitest";
import { mediaUrlFor } from "../../functions/mediaUrl";
import { cssUrlsAdmitted, fileUrlOf, installGraphicAssetUrlResolver } from "./fileUrl";

afterEach(() => installGraphicAssetUrlResolver(null));

describe("fileUrlOf", () => {
  it("is an escaped file:// URL on the desktop", () => {
    expect(fileUrlOf("/Users/me/My Pics/a#1?.png")).toBe("file:///Users/me/My%20Pics/a%231%3F.png");
    expect(fileUrlOf("C:\\art\\logo.png")).toBe("file:///C:/art/logo.png");
  });

  it("is the site's own path in the public browser build", () => {
    installGraphicAssetUrlResolver((path) => mediaUrlFor(path, "demo"));
    expect(fileUrlOf("/examples/templates/cartcut-promo/media/icon.png")).toBe(
      "/examples/templates/cartcut-promo/media/icon.png",
    );
  });

  it("goes through the file route on a self-hosted server", () => {
    installGraphicAssetUrlResolver((path) => mediaUrlFor(path, "web"));
    expect(fileUrlOf("/Users/me/icon.png")).toBe("/api/file?path=/Users/me/icon.png");
  });

  it("goes back to file:// when the resolver is taken away", () => {
    installGraphicAssetUrlResolver((path) => path);
    installGraphicAssetUrlResolver(null);
    expect(fileUrlOf("/a.png")).toBe("file:///a.png");
  });
});

describe("cssUrlsAdmitted", () => {
  it("admits a rule with no url() at all", () => {
    expect(cssUrlsAdmitted(".a { color: red; }")).toBe(true);
  });

  it("admits fragments and file:// URLs on the desktop, and nothing else", () => {
    expect(cssUrlsAdmitted('.a { filter: url(#glow); background: url("file:///x/a.png"); }')).toBe(true);
    expect(cssUrlsAdmitted('.a { background: url("/examples/a.png"); }')).toBe(false);
  });

  it("admits a root-relative site path once a browser build installed a resolver", () => {
    installGraphicAssetUrlResolver((path) => path);
    expect(cssUrlsAdmitted('.chip i { background: url("/examples/templates/x/media/icon.png") center / cover; }')).toBe(true);
    expect(cssUrlsAdmitted(".a { background: url(/api/file?path=/Users/me/a.png); }")).toBe(true);
    expect(cssUrlsAdmitted(".a { filter: url(#glow); }")).toBe(true);
  });

  it("refuses another site, a scheme, or one bad url() among good ones, resolver or not", () => {
    installGraphicAssetUrlResolver((path) => path);
    for (const css of [
      '.a { background: url("//evil.example/a.png"); }',
      '.a { background: url("https://evil.example/a.png"); }',
      ".a { background: url(data:image/png;base64,AAAA); }",
      '.a { background: url("/ok.png"), url("https://evil.example/b.png"); }',
    ]) {
      expect(cssUrlsAdmitted(css), css).toBe(false);
    }
  });
});
