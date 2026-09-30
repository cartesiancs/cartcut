/**
 * The process: stdio framing, configuration, and a clean exit.
 *
 * stdout carries the protocol and nothing else; a stray log line there is a
 * message the client cannot parse. Everything human-readable goes to stderr.
 */

import fs from "node:fs";
import os from "node:os";
import { createRelay } from "./relay.mjs";
import { Upstream, UpstreamError } from "./upstream.mjs";
import {
  noTokenMessage,
  resolveToken,
  resolveUrl,
} from "./config.mjs";

const USAGE = `cartcut-mcp: connects an MCP client to the CartCut video editor on this computer.

It speaks MCP over stdio, so it is started by a client rather than by hand:

  claude mcp add cartcut -- npx -y @cartesiancs/cartcut-mcp

CartCut must be open. The token is read from CartCut's own settings; set
CARTCUT_MCP_TOKEN to override it, and CARTCUT_MCP_URL to reach a CartCut that is
not on the default http://127.0.0.1:9826/mcp.
`;

/** Newline-delimited JSON, the stdio transport's framing. */
function createLineReader(onMessage, onInvalid) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        onInvalid(line);
        continue;
      }
      onMessage(message);
    }
  };
}

export function run({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  version = "unknown",
  exit = (code) => process.exit(code),
} = {}) {
  if (argv.includes("--version") || argv.includes("-v")) {
    stdout.write(`${version}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(USAGE);
    return;
  }
  if (stdin.isTTY) {
    stderr.write(USAGE);
  }

  const log = (text) => stderr.write(`[cartcut-mcp] ${text}\n`);
  const url = resolveUrl(env);

  const connect = (onmessage) => {
    const found = resolveToken({
      env,
      platform,
      home,
      readFile: (file) => fs.readFileSync(file, "utf8"),
    });
    if (found.token == null) {
      throw new UpstreamError("unauthorized", noTokenMessage(found));
    }
    return new Upstream({
      url,
      token: found.token,
      tokenSource: found.source,
      onmessage,
      log,
    });
  };

  const toClient = (message) => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };

  const relay = createRelay({ connect, toClient, log });

  const read = createLineReader(
    (message) => {
      relay.handle(message).catch((error) => {
        log(`unexpected: ${error?.stack ?? error}`);
      });
    },
    (line) => log(`ignored a line that is not JSON: ${line.slice(0, 200)}`),
  );

  let ending = false;
  const end = () => {
    if (ending) {
      return;
    }
    ending = true;
    relay.close().finally(() => exit(0));
  };

  stdin.setEncoding("utf8");
  stdin.on("data", read);
  // The client closing our stdin is how a stdio server is told to stop.
  stdin.on("end", end);
  stdin.on("close", end);
  // EPIPE: the client went away without closing stdin first.
  stdout.on("error", end);
  process.once("SIGINT", end);
  process.once("SIGTERM", end);
}
