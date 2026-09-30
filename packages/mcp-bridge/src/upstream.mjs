/**
 * One MCP session with CartCut's Streamable HTTP endpoint.
 *
 * `node:http` rather than `fetch`: Node's fetch abandons a response body that
 * has been quiet for 300 seconds, which is an ordinary gap in the notification
 * stream and in a long tool call, and it cannot be raised without installing
 * undici. Every request gets a fresh connection, so a keep-alive socket the
 * server has just closed can never turn a request that was never read into an
 * ECONNRESET that looks like one that was.
 */

import http from "node:http";
import https from "node:https";
import { createSseParser } from "./sse.mjs";

/**
 * Why a message did not get through.
 *
 * `kind` decides whether it may be sent again after a new session is opened:
 *
 *  - `unreachable`: nothing is listening. CartCut never saw the message.
 *  - `unauthorized`: refused at the door, before the message was read.
 *  - `session`: CartCut does not know this session, which is what an app
 *    restart looks like from here. Refused before the message was read.
 *  - `failed`: anything else. CartCut may have acted on the message, so it is
 *    never sent twice.
 */
export class UpstreamError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
  }
}

export function isResendable(error) {
  return (
    error instanceof UpstreamError &&
    (error.kind === "unreachable" ||
      error.kind === "unauthorized" ||
      error.kind === "session")
  );
}

const REFUSED = new Set(["ECONNREFUSED", "ENOTFOUND", "EADDRNOTAVAIL"]);

export class Upstream {
  /**
   * `tokenSource` names where the token came from, for the refusal message.
   * `onmessage` receives every JSON-RPC message CartCut sends, on any stream.
   */
  constructor({ url, token, tokenSource, onmessage, log = () => {} }) {
    this.url = new URL(url);
    this.token = token;
    this.tokenSource = tokenSource;
    this.onmessage = onmessage;
    this.log = log;
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.live = new Set();
    this.listening = false;
    this.disposed = false;
    this.transport = this.url.protocol === "https:" ? https : http;
  }

  headers(extra) {
    const headers = { authorization: `Bearer ${this.token}`, ...extra };
    if (this.sessionId != null) {
      headers["mcp-session-id"] = this.sessionId;
    }
    if (this.protocolVersion != null) {
      headers["mcp-protocol-version"] = this.protocolVersion;
    }
    return headers;
  }

  request(method, headers, onResponse) {
    const req = this.transport.request(this.url, {
      method,
      headers,
      agent: false,
    });
    this.live.add(req);
    req.on("close", () => this.live.delete(req));
    req.on("response", onResponse);
    return req;
  }

  deliver(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log(`CartCut sent something that is not JSON: ${text.slice(0, 200)}`);
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      this.onmessage(message);
    }
  }

  refusal(status, body) {
    if (status === 401) {
      return new UpstreamError(
        "unauthorized",
        `CartCut refused the token from ${this.tokenSource}. Copy the current one from ` +
          "the lightning icon at the bottom right of the CartCut window into CARTCUT_MCP_TOKEN, " +
          "or unset CARTCUT_MCP_TOKEN so the bridge reads it from CartCut's settings.",
      );
    }
    // The spec answers an unknown session with 404; CartCut answers 400, with
    // "No such MCP session" or "Expected an initialize request". Either way the
    // message was refused before anything read it.
    if (status === 400 || status === 404) {
      return new UpstreamError(
        "session",
        `CartCut does not know this session (HTTP ${status}).`,
      );
    }
    const detail = body.trim().slice(0, 300);
    return new UpstreamError(
      "failed",
      `CartCut answered HTTP ${status}${detail ? `: ${detail}` : ""}`,
    );
  }

  unreachable(error) {
    if (REFUSED.has(error?.code)) {
      return new UpstreamError(
        "unreachable",
        `CartCut is not running, or its MCP bridge is off: nothing is listening at ${this.url.href}. ` +
          "Open CartCut and try again.",
      );
    }
    return new UpstreamError(
      "failed",
      `The connection to CartCut broke (${error?.code ?? error?.message ?? error}). ` +
        "The request may have run; check the editor before repeating it.",
    );
  }

  /**
   * Send one message. Resolves once CartCut has finished answering it, having
   * handed every message in the answer to `onmessage` first.
   */
  post(message) {
    if (this.disposed) {
      return Promise.reject(new UpstreamError("session", "The session was closed."));
    }
    const body = JSON.stringify(message);

    return new Promise((resolve, reject) => {
      let settled = false;
      let responded = false;
      const settle = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const req = this.request(
        "POST",
        this.headers({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
        }),
        (res) => {
          responded = true;
          const session = res.headers["mcp-session-id"];
          if (typeof session === "string" && session.length > 0) {
            this.sessionId = session;
          }
          res.setEncoding("utf8");
          // An IncomingMessage with no error listener throws on ECONNRESET.
          // `close` below is where the outcome is decided.
          res.on("error", () => {});

          const status = res.statusCode ?? 0;
          const type = String(res.headers["content-type"] ?? "").split(";")[0].trim();
          let text = "";
          let parser = null;

          if (status >= 200 && status < 300 && type === "text/event-stream") {
            parser = createSseParser((event) => {
              if (event.event === "message") {
                this.deliver(event.data);
              }
            });
            res.on("data", (chunk) => parser.push(chunk));
          } else {
            res.on("data", (chunk) => {
              text += chunk;
            });
          }

          res.on("close", () => {
            if (!res.complete) {
              settle(
                new UpstreamError(
                  "failed",
                  "CartCut stopped answering partway through. " +
                    "The request may have run; check the editor before repeating it.",
                ),
              );
              return;
            }
            if (status < 200 || status >= 300) {
              settle(this.refusal(status, text));
              return;
            }
            if (parser == null && text.trim().length > 0) {
              this.deliver(text);
            }
            settle();
          });
        },
      );

      req.on("error", (error) => settle(this.unreachable(error)));
      // `dispose` destroying a request that has no response yet emits no
      // `error` on every Node version, and a promise nobody settles is a
      // client request nobody ever answers.
      req.on("close", () => {
        if (!responded) {
          settle(new UpstreamError("failed", "The request was abandoned before CartCut answered."));
        }
      });
      req.end(body);
    });
  }

  /**
   * Open the stream CartCut uses for messages nobody asked for: a changed tool
   * list when an extension activates, a log line. Losing it is not an error.
   * The next posted message finds out whether the session is still there.
   */
  listen() {
    if (this.listening || this.disposed || this.sessionId == null) {
      return;
    }
    this.listening = true;
    const req = this.request(
      "GET",
      this.headers({ accept: "text/event-stream" }),
      (res) => {
        res.setEncoding("utf8");
        res.on("error", () => {});
        if (res.statusCode !== 200) {
          res.resume();
          return;
        }
        const parser = createSseParser((event) => {
          if (event.event === "message") {
            this.deliver(event.data);
          }
        });
        res.on("data", (chunk) => parser.push(chunk));
      },
    );
    req.on("error", () => {});
    req.on("close", () => {
      this.listening = false;
    });
    req.end();
  }

  /** Drop every open request. For a session CartCut has already forgotten. */
  dispose() {
    this.disposed = true;
    for (const req of this.live) {
      req.destroy();
    }
    this.live.clear();
  }

  /**
   * End the session politely, then drop it. Bounded, because this runs on the
   * way out of a process whose client has already gone.
   */
  async terminate(timeoutMs = 1000) {
    if (this.disposed) {
      return;
    }
    if (this.sessionId != null) {
      await new Promise((resolve) => {
        const req = this.request("DELETE", this.headers({}), (res) => {
          res.resume();
          res.on("error", () => {});
          res.on("close", resolve);
        });
        req.on("error", resolve);
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          resolve();
        });
        req.end();
      });
    }
    this.dispose();
  }
}
