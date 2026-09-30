import { describe, expect, it } from "vitest";
import {
  DEFAULT_URL,
  configPath,
  noTokenMessage,
  present,
  resolveToken,
  resolveUrl,
} from "./config.mjs";

describe("configPath", () => {
  it("is Electron's userData on macOS", () => {
    expect(configPath({ platform: "darwin", env: {}, home: "/Users/me" })).toBe(
      "/Users/me/Library/Application Support/cartcut-app/config.json",
    );
  });

  it("is under APPDATA on Windows, with backslashes", () => {
    expect(
      configPath({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        home: "C:\\Users\\me",
      }),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\cartcut-app\\config.json");
  });

  it("falls back to the roaming folder when APPDATA is unset", () => {
    expect(
      configPath({ platform: "win32", env: {}, home: "C:\\Users\\me" }),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\cartcut-app\\config.json");
  });

  it("honours XDG_CONFIG_HOME on Linux, as Electron does", () => {
    expect(
      configPath({
        platform: "linux",
        env: { XDG_CONFIG_HOME: "/tmp/xdg" },
        home: "/home/me",
      }),
    ).toBe("/tmp/xdg/cartcut-app/config.json");
    expect(configPath({ platform: "linux", env: {}, home: "/home/me" })).toBe(
      "/home/me/.config/cartcut-app/config.json",
    );
  });
});

describe("present", () => {
  it("reads an empty or unexpanded variable as unset", () => {
    expect(present(undefined)).toBeNull();
    expect(present("")).toBeNull();
    expect(present("   ")).toBeNull();
    expect(present("${CARTCUT_MCP_TOKEN}")).toBeNull();
    expect(present(" abc ")).toBe("abc");
  });
});

describe("resolveUrl", () => {
  it("defaults to the app's loopback endpoint", () => {
    expect(resolveUrl({})).toBe(DEFAULT_URL);
    expect(resolveUrl({ CARTCUT_MCP_URL: "" })).toBe(DEFAULT_URL);
    expect(resolveUrl({ CARTCUT_MCP_URL: "http://127.0.0.1:1/mcp" })).toBe(
      "http://127.0.0.1:1/mcp",
    );
  });
});

describe("resolveToken", () => {
  const home = "/Users/me";
  const file = "/Users/me/Library/Application Support/cartcut-app/config.json";
  const reader = (files) => (path) => {
    if (!(path in files)) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return files[path];
  };

  it("prefers the variable over the app's settings", () => {
    const result = resolveToken({
      env: { CARTCUT_MCP_TOKEN: "from-env" },
      platform: "darwin",
      home,
      readFile: reader({ [file]: JSON.stringify({ mcp_token: "from-file" }) }),
    });
    expect(result).toEqual({ token: "from-env", source: "CARTCUT_MCP_TOKEN" });
  });

  it("reads the app's settings when the variable is unset or unexpanded", () => {
    for (const env of [{}, { CARTCUT_MCP_TOKEN: "${CARTCUT_MCP_TOKEN}" }]) {
      const result = resolveToken({
        env,
        platform: "darwin",
        home,
        readFile: reader({
          [file]: JSON.stringify({ mcp_token: "from-file", record: {} }),
        }),
      });
      expect(result).toEqual({ token: "from-file", source: file });
    }
  });

  it("says why there is no token", () => {
    const missing = resolveToken({ env: {}, platform: "darwin", home, readFile: reader({}) });
    expect(missing).toMatchObject({ token: null, source: file, reason: "missing" });

    const broken = resolveToken({
      env: {},
      platform: "darwin",
      home,
      readFile: reader({ [file]: "{not json" }),
    });
    expect(broken).toMatchObject({ token: null, reason: "unreadable" });
    expect(noTokenMessage(broken)).toContain("not valid JSON");

    const absent = resolveToken({
      env: {},
      platform: "darwin",
      home,
      readFile: reader({ [file]: JSON.stringify({ LANG: "en" }) }),
    });
    expect(absent).toMatchObject({ token: null, reason: "absent" });
    expect(noTokenMessage(absent)).toContain(file);
  });
});
