/**
 * One request/response endpoint, over any port, in any of the three processes.
 *
 * `electron/mcp/bridge.ts` states the three defects this shape exists to
 * avoid, and they are the same three here: a listener registered per call and
 * never removed, no request id so two calls in flight resolve each other, and
 * no timeout so a wedged peer hangs the caller forever. An extension host is
 * exactly the peer that makes all three fire, because it is long lived and a
 * third party wrote it.
 *
 * What is different from the MCP bridge is that both ends of this one send.
 * The editor calls the host (a keybinding was pressed) as often as the host
 * calls the editor, so `request` and the inbound handler are one object rather
 * than two modules.
 *
 * Pure over `PortLike`, which is satisfied by `MessagePortMain` in main and in
 * the host and by an adapter around the DOM `MessagePort` in the renderer.
 * That is what lets one suite cover all three ends, and it is the reason this
 * module imports nothing: no `electron`, no DOM, no timers beyond the globals.
 */

import {
  DEFAULT_TIMEOUT_MS,
  MAX_PARAMS_BYTES,
  MAX_RESULT_BYTES,
  type ErrorCode,
  type RpcMessage,
} from "./protocol";

/**
 * The part of a port this needs.
 *
 * `close` is optional because the DOM `MessagePort` has no close event at all:
 * the renderer adapter synthesises one from the host's exit notice instead.
 * Treating it as optional here rather than faking one in the adapter keeps the
 * fact visible at the place that depends on it.
 */
export type PortLike = {
  postMessage(message: unknown): void;
  onMessage(handler: (data: unknown) => void): void;
  onClose?(handler: () => void): void;
  start?(): void;
  close?(): void;
};

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** What an inbound request is handed. `signal` fires when the peer cancels. */
export type InboundRequest = {
  method: string;
  params: unknown;
  ext?: string;
  signal: AbortSignal;
};

export type RpcHandlers = {
  request?: (request: InboundRequest) => Promise<unknown> | unknown;
  event?: (event: { event: string; params: unknown; ext?: string }) => void;
  /** Called once when the port closes, after every pending call is rejected. */
  close?: () => void;
};

export type RequestOptions = {
  timeoutMs?: number;
  ext?: string;
  signal?: AbortSignal;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
};

/**
 * How many bytes a value occupies once serialised.
 *
 * Measured on the JSON form rather than on the structured clone, because JSON
 * is what the caps in `protocol.ts` are expressed in and what a log line can
 * report. A value that cannot be serialised at all counts as over the cap: it
 * would fail at `postMessage` anyway, and failing here names the method.
 */
function sizeOf(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text == null ? 0 : text.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

let counter = 0;

/**
 * An id unique within this endpoint.
 *
 * Not `randomUUID`: this module is compiled into the renderer bundle too,
 * where `node:crypto` does not resolve, and `crypto.randomUUID` is absent in
 * some of the contexts a webview runs in. A counter plus the endpoint's own
 * random prefix is enough, because an id only has to be unique against the
 * other calls on this one port.
 */
function makeIdFactory(): () => string {
  const prefix = Math.random().toString(36).slice(2, 10);
  return () => {
    counter += 1;
    return prefix + "-" + counter.toString(36);
  };
}

export type RpcEndpoint = {
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  emit(event: string, params: unknown, ext?: string): void;
  /** Rejects every pending call and stops answering. Idempotent. */
  dispose(reason?: string): void;
  pendingCount(): number;
};

export function createRpcEndpoint(port: PortLike, handlers: RpcHandlers = {}): RpcEndpoint {
  const pending = new Map<string, Pending>();
  const inbound = new Map<string, AbortController>();
  const nextId = makeIdFactory();
  let disposed = false;

  function send(message: RpcMessage): void {
    if (disposed) {
      return;
    }
    try {
      port.postMessage(message);
    } catch (error) {
      // A closed port throws rather than dropping. Failing every pending call
      // here is the difference between a caller seeing an error and a caller
      // waiting out its whole timeout for a port that will never answer.
      failAll("E_INTERNAL", "extension port is closed: " + String(error));
    }
  }

  function failAll(code: ErrorCode, message: string): void {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.detach();
      pending.delete(id);
      entry.reject(new RpcError(code, message));
    }
    for (const [, controller] of inbound) {
      controller.abort();
    }
    inbound.clear();
  }

  function respond(id: string, ok: boolean, payload: unknown): void {
    if (ok) {
      const bytes = sizeOf(payload);
      if (bytes > MAX_RESULT_BYTES) {
        send({
          id,
          ok: false,
          error: {
            code: "E_TOO_LARGE",
            message:
              "result is " + bytes + " bytes, over the " + MAX_RESULT_BYTES + " byte cap",
          },
        });
        return;
      }
      send({ id, ok: true, result: payload });
      return;
    }
    const error =
      payload instanceof RpcError
        ? { code: payload.code, message: payload.message, data: payload.data }
        : {
            code: "E_INTERNAL" as ErrorCode,
            message: payload instanceof Error ? payload.message : String(payload),
          };
    send({ id, ok: false, error });
  }

  async function handleRequest(message: { id: string; method: string; params: unknown; ext?: string }): Promise<void> {
    if (handlers.request == null) {
      respond(message.id, false, new RpcError("E_UNKNOWN_METHOD", "this endpoint answers no requests"));
      return;
    }

    const controller = new AbortController();
    inbound.set(message.id, controller);
    try {
      const result = await handlers.request({
        method: message.method,
        params: message.params,
        ext: message.ext,
        signal: controller.signal,
      });
      // An aborted call has already been answered by the peer's own timeout or
      // will be discarded by it. Answering again would be a second response
      // for one id, which the peer drops but which shows up in a log as a
      // protocol violation nobody can explain.
      if (!controller.signal.aborted) {
        respond(message.id, true, result);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        respond(message.id, false, error);
      }
    } finally {
      inbound.delete(message.id);
    }
  }

  function receive(data: unknown): void {
    if (disposed || data == null || typeof data !== "object") {
      return;
    }
    const message = data as Record<string, unknown>;

    if (typeof message.method === "string" && message.method === "$/cancel") {
      const params = message.params as { id?: string } | undefined;
      const target = params?.id;
      if (typeof target === "string") {
        inbound.get(target)?.abort();
      }
      return;
    }

    if (typeof message.method === "string" && typeof message.id === "string") {
      void handleRequest({
        id: message.id,
        method: message.method,
        params: message.params,
        ext: typeof message.ext === "string" ? message.ext : undefined,
      });
      return;
    }

    if (typeof message.id === "string" && "ok" in message) {
      const entry = pending.get(message.id);
      if (entry == null) {
        // A reply that arrived after its own timeout. Dropping it is correct:
        // the caller already got an error and moved on.
        return;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.detach();
      if (message.ok === true) {
        entry.resolve(message.result);
      } else {
        const error = (message.error ?? {}) as { code?: ErrorCode; message?: string; data?: unknown };
        entry.reject(new RpcError(error.code ?? "E_INTERNAL", error.message ?? "unknown error", error.data));
      }
      return;
    }

    if (typeof message.event === "string" && handlers.event != null) {
      handlers.event({
        event: message.event,
        params: message.params,
        ext: typeof message.ext === "string" ? message.ext : undefined,
      });
    }
  }

  port.onMessage(receive);
  port.onClose?.(() => {
    if (disposed) {
      return;
    }
    disposed = true;
    failAll("E_INTERNAL", "extension port closed");
    handlers.close?.();
  });
  port.start?.();

  return {
    request(method, params = {}, options = {}) {
      if (disposed) {
        return Promise.reject(new RpcError("E_INTERNAL", "endpoint disposed"));
      }

      const bytes = sizeOf(params);
      if (bytes > MAX_PARAMS_BYTES) {
        return Promise.reject(
          new RpcError(
            "E_TOO_LARGE",
            method + " params are " + bytes + " bytes, over the " + MAX_PARAMS_BYTES + " byte cap",
          ),
        );
      }

      const id = nextId();
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.get(id)?.detach();
          pending.delete(id);
          // Tell the peer to stop. Without this a timed-out edit keeps running
          // in the host and lands after the caller gave up, which for a
          // mutating command means an undo step nobody asked for.
          send({ method: "$/cancel", params: { id } });
          reject(new RpcError("E_TIMEOUT", method + " did not answer within " + timeoutMs + "ms"));
        }, timeoutMs);

        const onAbort = () => {
          const entry = pending.get(id);
          if (entry == null) {
            return;
          }
          clearTimeout(entry.timer);
          entry.detach();
          pending.delete(id);
          send({ method: "$/cancel", params: { id } });
          reject(new RpcError("E_CANCELLED", method + " was cancelled"));
        };

        const detach = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };

        if (options.signal?.aborted) {
          clearTimeout(timer);
          reject(new RpcError("E_CANCELLED", method + " was cancelled before it was sent"));
          return;
        }
        options.signal?.addEventListener("abort", onAbort);

        pending.set(id, { resolve, reject, timer, detach });
        send({ id, method, params, ...(options.ext == null ? {} : { ext: options.ext }) });
      });
    },

    emit(event, params, ext) {
      send({ event, params, ...(ext == null ? {} : { ext }) });
    },

    dispose(reason = "endpoint disposed") {
      if (disposed) {
        return;
      }
      disposed = true;
      failAll("E_INTERNAL", reason);
      port.close?.();
    },

    pendingCount() {
      return pending.size;
    },
  };
}
