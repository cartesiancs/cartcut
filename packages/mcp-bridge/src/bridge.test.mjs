/**
 * The bridge end to end: the SDK's client spawns the real `bin` over stdio, and
 * the bridge talks to a stand-in CartCut built on the SDK's own server
 * transport. The bridge's HTTP client is hand-written, so it is checked against
 * code it shares nothing with.
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ToolListChangedNotificationSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { configPath } from "./config.mjs";

const BIN = fileURLToPath(new URL("../bin/cartcut-mcp.mjs", import.meta.url));
const TOKEN = "3f0c5a52-test-token";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()();
  }
});

/**
 * The door of `electron/mcp/server.ts`: a bearer token, a transport per
 * session, and a 400 for a session it does not know, which is what the bridge
 * sees after CartCut restarts.
 */
async function fakeCartCut({ port = 0, extraTool = false } = {}) {
  const sessions = new Map();
  const calls = { echo: 0, hang: 0 };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length > 0 ? JSON.parse(raw) : undefined;

    const id = req.headers["mcp-session-id"];
    const existing = typeof id === "string" ? sessions.get(id) : undefined;
    if (existing != null) {
      await existing.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(body)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No such MCP session" },
          id: null,
        }),
      );
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => sessions.set(sid, transport),
    });
    const mcp = new McpServer(
      { name: "cartcut", version: "test" },
      { instructions: "fake CartCut" },
    );
    mcp.registerTool(
      "echo",
      { description: "echo", inputSchema: { text: z.string() } },
      async ({ text }) => {
        calls.echo += 1;
        return { content: [{ type: "text", text }] };
      },
    );
    mcp.registerTool("hang", { description: "never answers" }, async () => {
      calls.hang += 1;
      return new Promise(() => {});
    });
    if (extraTool) {
      mcp.registerTool("extra", { description: "added later" }, async () => ({
        content: [{ type: "text", text: "extra" }],
      }));
    }
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  let open = true;
  const close = async () => {
    if (!open) {
      return;
    }
    open = false;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  cleanup.push(close);
  return { port: server.address().port, sessions, calls, close };
}

/** A home directory of our own, so the bridge never reads the real config. */
function isolatedEnv({ port, token, fileToken }) {
  const home = mkdtempSync(path.join(tmpdir(), "cartcut-mcp-"));
  cleanup.push(async () => rmSync(home, { recursive: true, force: true }));
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CARTCUT_MCP_URL: `http://127.0.0.1:${port}/mcp`,
  };
  if (token != null) {
    env.CARTCUT_MCP_TOKEN = token;
  }
  if (fileToken != null) {
    const file = configPath({ platform: process.platform, env, home });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ mcp_token: fileToken, record: {} }));
  }
  return env;
}

async function connectClient(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env,
    stderr: "pipe",
  });
  const log = [];
  transport.stderr?.on("data", (chunk) => log.push(String(chunk)));
  const client = new Client({ name: "bridge-test", version: "0" });
  cleanup.push(() => client.close().catch(() => {}));
  await client.connect(transport);
  return { client, log };
}

async function waitFor(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function postWithSession(port, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  });
}

describe("cartcut-mcp", { timeout: 20000 }, () => {
  it("relays CartCut's tools, results and instructions, with the token from CartCut's settings", async () => {
    const app = await fakeCartCut();
    const { client } = await connectClient(
      isolatedEnv({ port: app.port, fileToken: TOKEN }),
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "hang"]);
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "한 번" },
    });
    expect(result.content).toEqual([{ type: "text", text: "한 번" }]);
    expect(client.getInstructions()).toBe("fake CartCut");
    expect(app.calls.echo).toBe(1);
  });

  it("carries on across a CartCut restart and tells the client to re-read the tools", async () => {
    const first = await fakeCartCut();
    const { client } = await connectClient(
      isolatedEnv({ port: first.port, token: TOKEN }),
    );
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed += 1;
    });
    await client.callTool({ name: "echo", arguments: { text: "before" } });
    const [oldSession] = first.sessions.keys();

    await first.close();
    const second = await fakeCartCut({ port: first.port, extraTool: true });

    // The restart really did lose the session: without the replay, the next
    // call would be refused exactly like this.
    expect(await postWithSession(second.port, oldSession)).toBe(400);

    const result = await client.callTool({
      name: "echo",
      arguments: { text: "after" },
    });
    expect(result.content).toEqual([{ type: "text", text: "after" }]);
    expect(second.calls.echo).toBe(1);
    expect(second.sessions.size).toBe(1);
    expect(second.sessions.has(oldSession)).toBe(false);

    await waitFor(() => changed > 0);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("extra");
  });

  it("does not send a call again when CartCut closed while running it", async () => {
    const first = await fakeCartCut();
    const { client } = await connectClient(
      isolatedEnv({ port: first.port, token: TOKEN }),
    );

    const pending = client.callTool({ name: "hang", arguments: {} });
    await waitFor(() => first.calls.hang === 1);
    await first.close();
    await expect(pending).rejects.toThrow(/may have run/);

    const second = await fakeCartCut({ port: first.port });
    await client.callTool({ name: "echo", arguments: { text: "next" } });
    expect(second.calls.echo).toBe(1);
    expect(second.calls.hang).toBe(0);
  });

  it("says CartCut is not running instead of hanging", async () => {
    const gone = await fakeCartCut();
    await gone.close();
    await expect(
      connectClient(isolatedEnv({ port: gone.port, token: TOKEN })),
    ).rejects.toThrow(/CartCut is not running/);
  });

  it("names the token CartCut refused", async () => {
    const app = await fakeCartCut();
    await expect(
      connectClient(isolatedEnv({ port: app.port, token: "stale" })),
    ).rejects.toThrow(/refused the token from CARTCUT_MCP_TOKEN/);
  });

  it("says where it looked when there is no token at all", async () => {
    const app = await fakeCartCut();
    await expect(
      connectClient(isolatedEnv({ port: app.port })),
    ).rejects.toThrow(/Open CartCut once/);
  });
});
