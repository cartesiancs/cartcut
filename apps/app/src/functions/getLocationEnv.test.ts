import { describe, expect, it } from "vitest";
import { locationEnvOf } from "./getLocationEnv";

const at = (href: string) => {
  const url = new URL(href);
  return locationEnvOf({ protocol: url.protocol, hostname: url.hostname });
};

describe("locationEnvOf", () => {
  it("is the public build on the public site", () => {
    expect(at("https://cartcut.cartesiancs.com/")).toBe("demo");
    expect(at("https://cartcut.cartesiancs.com/?template=dont-blink")).toBe("demo");
  });

  it("is the public build on every Cloudflare Pages address", () => {
    expect(at("https://cartcut.pages.dev/")).toBe("demo");
    expect(at("https://3f2a1b9c.cartcut.pages.dev/")).toBe("demo");
    expect(at("https://claude-template-link.cartcut.pages.dev/?template=dont-blink")).toBe("demo");
  });

  it("does not mistake a host that only contains the name", () => {
    expect(at("https://notpages.dev/")).toBe("web");
    expect(at("https://pages.dev.example.com/")).toBe("web");
    expect(at("https://cartcut.cartesiancs.com.example.com/")).toBe("web");
  });

  it("is the self-hosted build on any other web host, port or not", () => {
    expect(at("http://localhost:3000/")).toBe("web");
    expect(at("https://editor.example.com/")).toBe("web");
  });

  it("is the desktop app off the web", () => {
    expect(at("file:///Applications/Cartcut.app/Contents/Resources/app.asar/apps/app/index.html")).toBe(
      "electron",
    );
  });
});
