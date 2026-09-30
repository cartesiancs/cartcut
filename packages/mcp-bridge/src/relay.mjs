/**
 * The bridge proper: JSON-RPC in from the client over stdio, out to CartCut
 * over HTTP, and everything CartCut says handed back unchanged.
 *
 * A relay rather than an MCP client and server of its own, so that nothing
 * CartCut offers (its tools, the skill resource, the instructions, a tool list
 * that grows when an extension activates) has to be taught to the bridge first.
 *
 * What it adds is surviving CartCut restarting. A stdio server lives as long as
 * the client's session, while the app underneath it is quit, updated and
 * relaunched, and each time the session CartCut held is gone. So the bridge
 * keeps the client's `initialize` and replays it once when a message is refused
 * for a session CartCut no longer knows, then tells the client to re-read the
 * tool list, which an extension may have changed in between.
 *
 * Only a message CartCut refused unread is sent again. A tool call that broke
 * after CartCut may have run it is answered with an error instead, because
 * sending it twice would turn one edit into two.
 */

import { UpstreamError, isResendable } from "./upstream.mjs";

/** JSON-RPC's server-error range; the SDK uses it for a closed connection. */
const BRIDGE_ERROR = -32000;

const LIST_CHANGED = [
  ["tools", "notifications/tools/list_changed"],
  ["resources", "notifications/resources/list_changed"],
  ["prompts", "notifications/prompts/list_changed"],
];

function isRequest(message) {
  return (
    message != null &&
    typeof message === "object" &&
    typeof message.method === "string" &&
    "id" in message
  );
}

function isResponse(message) {
  return (
    message != null &&
    typeof message === "object" &&
    !("method" in message) &&
    "id" in message
  );
}

/**
 * `connect(onmessage)` opens a new `Upstream`, resolving the URL and token
 * afresh each time, so a token CartCut minted after the client started is
 * picked up by the next attempt. It may throw an `UpstreamError`.
 *
 * `toClient(message)` writes one message to the client.
 */
export function createRelay({ connect, toClient, log = () => {} }) {
  let upstream = null;
  let initialize = null;
  let capabilities = null;
  let clientInitialized = false;
  let reconnecting = null;
  let ownIds = 0;
  let closed = false;

  /** Client requests CartCut has not answered yet, so each gets exactly one answer. */
  const unanswered = new Set();
  /** Answers to requests the bridge sent itself, which the client never sees. */
  const own = new Map();

  function fromUpstream(message) {
    if (isResponse(message)) {
      if (own.has(message.id)) {
        own.set(message.id, message);
        return;
      }
      if (initialize != null && message.id === initialize.id && capabilities == null) {
        adopt(upstream, message);
      }
      unanswered.delete(message.id);
    }
    toClient(message);
  }

  function adopt(session, response) {
    const result = response?.result;
    if (result == null || session == null) {
      return;
    }
    session.protocolVersion = result.protocolVersion;
    capabilities = result.capabilities ?? {};
  }

  function answerWithError(message, error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!isRequest(message)) {
      log(`dropped ${message?.method ?? "a message"}: ${text}`);
      return;
    }
    if (!unanswered.delete(message.id)) {
      return;
    }
    toClient({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: BRIDGE_ERROR, message: text },
    });
  }

  async function post(session, message) {
    await session.post(message);
    if (isRequest(message) && unanswered.has(message.id)) {
      throw new UpstreamError(
        "failed",
        "CartCut closed the stream without answering. " +
          "The request may have run; check the editor before repeating it.",
      );
    }
  }

  async function start(message) {
    initialize = message;
    capabilities = null;
    clientInitialized = false;
    upstream?.dispose();
    upstream = null;
    unanswered.add(message.id);
    try {
      upstream = connect(fromUpstream);
      await post(upstream, message);
    } catch (error) {
      answerWithError(message, error);
    }
  }

  /**
   * A new session in place of `stale`, introduced with the client's own
   * `initialize` under an id of the bridge's.
   */
  async function replay() {
    const next = connect(fromUpstream);
    const id = `cartcut-mcp:${++ownIds}`;
    own.set(id, null);
    let answer;
    try {
      await next.post({ ...initialize, id });
      answer = own.get(id);
    } catch (error) {
      next.dispose();
      throw error;
    } finally {
      own.delete(id);
    }
    if (answer?.result == null) {
      next.dispose();
      throw new UpstreamError(
        "failed",
        `CartCut would not start a new session: ${answer?.error?.message ?? "no answer"}`,
      );
    }
    next.protocolVersion = answer.result.protocolVersion;
    capabilities = answer.result.capabilities ?? capabilities;
    if (clientInitialized) {
      await next.post({ jsonrpc: "2.0", method: "notifications/initialized" });
      next.listen();
    }

    const stale = upstream;
    upstream = next;
    stale?.dispose();
    log("CartCut restarted; opened a new session");

    for (const [kind, method] of LIST_CHANGED) {
      if (capabilities?.[kind]?.listChanged) {
        toClient({ jsonrpc: "2.0", method });
      }
    }
  }

  function reconnectFrom(stale) {
    if (upstream !== stale) {
      // Another message already replaced it.
      return Promise.resolve();
    }
    reconnecting ??= replay().finally(() => {
      reconnecting = null;
    });
    return reconnecting;
  }

  async function forward(message) {
    if (reconnecting != null) {
      await reconnecting.catch(() => {});
    }
    if (isRequest(message)) {
      unanswered.add(message.id);
    }
    const session = upstream;
    if (session == null) {
      answerWithError(
        message,
        new UpstreamError("failed", "CartCut was not reachable when this session began."),
      );
      return;
    }

    try {
      await post(session, message);
    } catch (error) {
      if (!isResendable(error) || initialize == null) {
        answerWithError(message, error);
        return;
      }
      try {
        await reconnectFrom(session);
        await post(upstream, message);
      } catch (again) {
        answerWithError(message, again);
      }
    }
  }

  async function handle(message) {
    if (closed) {
      return;
    }
    if (isRequest(message) && message.method === "initialize") {
      await start(message);
      return;
    }
    if (message?.method === "notifications/initialized") {
      clientInitialized = true;
      await forward(message);
      upstream?.listen();
      return;
    }
    await forward(message);
  }

  async function close() {
    closed = true;
    const session = upstream;
    upstream = null;
    await session?.terminate();
  }

  return { handle, close };
}
