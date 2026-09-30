/**
 * What the bridge copies from the app by hand, and what a release has to keep
 * in agreement. Each of these fails at the user's first connection and nowhere
 * earlier, so they are pinned here.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_DIR, DEFAULT_URL } from "./config.mjs";

const read = (relative) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

const pkg = JSON.parse(read("../package.json"));
const server = JSON.parse(read("../server.json"));
const app = JSON.parse(read("../../../package.json"));
const appServer = read("../../../electron/mcp/server.ts");

describe("the copies of the app's facts", () => {
  it("looks for the token in the folder Electron names after the app", () => {
    // A top-level `productName` would take over `app.name` and move userData;
    // `build.productName` is electron-builder's and does not.
    expect(app.productName).toBeUndefined();
    expect(app.name).toBe(APP_DIR);
  });

  it("reads the key the app stores the token under", () => {
    expect(appServer).toContain('store.get("mcp_token")');
  });

  it("dials the address the app listens on", () => {
    const port = appServer.match(/MCP_PORT = (\d+)/)?.[1];
    const host = appServer.match(/MCP_HOST = "([^"]+)"/)?.[1];
    const path = appServer.match(/MCP_PATH = "([^"]+)"/)?.[1];
    expect(DEFAULT_URL).toBe(`http://${host}:${port}${path}`);
  });
});

describe("the release manifests", () => {
  it("agree on the version in all three places", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  it("name each other, which is how the registry verifies ownership", () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].registryType).toBe("npm");
  });

  it("have no runtime dependencies, so npx starts it without an install", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
