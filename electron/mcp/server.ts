/**
 * The MCP server Claude Code connects to.
 *
 * Replaces the demo server that shipped before: that one exposed an `add` tool
 * and a `greeting://` resource, spoke the deprecated HTTP+SSE transport, held a
 * single module-level `transport` so a second client silently displaced the
 * first, and threw `EADDRINUSE` unhandled if its button was pressed twice.
 *
 * Streamable HTTP rather than stdio, because a stdio server is spawned per
 * Claude Code session and could never reach the editor that is already running
 * — which is the entire point. Bare `http.createServer` rather than Express,
 * because the SDK depends on Express 5 while this app uses Express 4, and the
 * transport wants the raw request anyway.
 */

import http from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import Store from "electron-store";
import { registerTools } from "./tools";

const store = new Store();

export const MCP_PORT = 9826;
/** Loopback only. The old server bound every interface. */
export const MCP_HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";

let server: http.Server | null = null;

/**
 * One transport per session, so two Claude Code windows can hold two
 * conversations with the same editor without trampling each other.
 */
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * The shared secret Claude Code presents.
 *
 * Loopback keeps other machines out; the token keeps other *processes* on this
 * machine out, which matters because the tools can rewrite the user's project.
 * Generated once and kept, so the `claude mcp add` line the settings dialog
 * hands out stays valid.
 */
export function mcpToken(): string {
  const existing = store.get("mcp_token");
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  const token = randomUUID();
  store.set("mcp_token", token);
  return token;
}

export function mcpUrl(): string {
  return `http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`;
}

/** The command a user pastes into their terminal to connect. */
export function mcpAddCommand(): string {
  return `claude mcp add --transport http cartcut ${mcpUrl()} --header "Authorization: Bearer ${mcpToken()}"`;
}

export function isMcpRunning(): boolean {
  return server != null && server.listening;
}

function unauthorized(res: http.ServerResponse) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    }),
  );
}

function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value === mcpToken();
}

/**
 * Reject cross-origin requests outright.
 *
 * A page in the user's browser can reach a loopback port; `Origin` is what
 * distinguishes it from a local process. An MCP client sends no `Origin` at
 * all, so anything that does send one is not the client we want.
 */
function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin == null) {
    return true;
  }
  return (
    origin === `http://${MCP_HOST}:${MCP_PORT}` ||
    origin === `http://localhost:${MCP_PORT}`
  );
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body was not valid JSON"));
      }
    });
  });
}

function newMcpServer(): McpServer {
  const mcp = new McpServer({
    name: "cartcut",
    version: "0.4.3",
  });
  registerTools(mcp);
  return mcp;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${MCP_HOST}:${MCP_PORT}`);
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }

  if (!isSameOrigin(req) || !isAuthorized(req)) {
    unauthorized(res);
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  const existing =
    typeof sessionId === "string" ? transports.get(sessionId) : undefined;

  if (existing != null) {
    const body = req.method === "POST" ? await readBody(req) : undefined;
    await existing.handleRequest(req, res, body);
    return;
  }

  if (req.method !== "POST") {
    // A GET or DELETE with no session is a client resuming something that is
    // gone — after an app restart, say.
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No such MCP session" },
        id: null,
      }),
    );
    return;
  }

  const body = await readBody(req);

  if (!isInitializeRequest(body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Expected an initialize request to start a session",
        },
        id: null,
      }),
    );
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
    },
    onsessionclosed: (id) => {
      transports.delete(id);
    },
  });

  transport.onclose = () => {
    if (transport.sessionId != null) {
      transports.delete(transport.sessionId);
    }
  };

  // A server instance per session: `McpServer` binds to one transport, and
  // sharing one across sessions is what broke the previous implementation.
  await newMcpServer().connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * Start listening. Safe to call repeatedly — the previous version threw an
 * unhandled `EADDRINUSE` on a second press of its own button.
 */
export function startMcpServer(): Promise<{
  ok: boolean;
  url: string;
  token: string;
  alreadyRunning: boolean;
  error?: string;
}> {
  if (isMcpRunning()) {
    return Promise.resolve({
      ok: true,
      url: mcpUrl(),
      token: mcpToken(),
      alreadyRunning: true,
    });
  }

  return new Promise((resolve) => {
    const next = http.createServer((req, res) => {
      handle(req, res).catch((error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: String(error?.message ?? error) },
            id: null,
          }),
        );
      });
    });

    next.once("error", (error: NodeJS.ErrnoException) => {
      server = null;
      resolve({
        ok: false,
        url: mcpUrl(),
        token: mcpToken(),
        alreadyRunning: false,
        error:
          error.code === "EADDRINUSE"
            ? `Port ${MCP_PORT} is already in use. Another Cartcut window may be running.`
            : String(error.message),
      });
    });

    next.listen(MCP_PORT, MCP_HOST, () => {
      server = next;
      console.log(`[mcp] Cartcut MCP server listening on ${mcpUrl()}`);
      resolve({
        ok: true,
        url: mcpUrl(),
        token: mcpToken(),
        alreadyRunning: false,
      });
    });
  });
}

export async function stopMcpServer() {
  for (const transport of transports.values()) {
    await transport.close().catch(() => {});
  }
  transports.clear();
  server?.close();
  server = null;
}
