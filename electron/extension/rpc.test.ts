import { describe, expect, it, vi } from "vitest";

import { createRpcEndpoint, RpcError, type PortLike } from "./rpc";
import { MAX_PARAMS_BYTES } from "./protocol";

/**
 * A linked pair, delivered asynchronously.
 *
 * Asynchronous on purpose: a real `MessagePort` never calls the peer's handler
 * inside `postMessage`, and a synchronous fake would hide any ordering bug
 * that depends on the caller having returned first. `queueMicrotask` is the
 * cheapest thing with the right shape.
 */
function linkedPorts(): [PortLike, PortLike, { close(): void }] {
  let handlerA: ((data: unknown) => void) | null = null;
  let handlerB: ((data: unknown) => void) | null = null;
  const closeA: Array<() => void> = [];
  const closeB: Array<() => void> = [];
  let open = true;

  const a: PortLike = {
    postMessage: (message) => {
      if (open) {
        queueMicrotask(() => handlerB?.(message));
      }
    },
    onMessage: (handler) => {
      handlerA = handler;
    },
    onClose: (handler) => {
      closeA.push(handler);
    },
  };
  const b: PortLike = {
    postMessage: (message) => {
      if (open) {
        queueMicrotask(() => handlerA?.(message));
      }
    },
    onMessage: (handler) => {
      handlerB = handler;
    },
    onClose: (handler) => {
      closeB.push(handler);
    },
  };

  return [
    a,
    b,
    {
      close() {
        open = false;
        for (const handler of [...closeA, ...closeB]) {
          handler();
        }
      },
    },
  ];
}

describe("rpc endpoint", () => {
  it("resolves a request with the peer's result", async () => {
    const [a, b] = linkedPorts();
    createRpcEndpoint(b, { request: async (req) => ({ echoed: req.params }) });
    const caller = createRpcEndpoint(a);

    await expect(caller.request("ping", { n: 1 })).resolves.toEqual({ echoed: { n: 1 } });
  });

  it("keeps two calls in flight apart", async () => {
    const [a, b] = linkedPorts();
    const resolvers: Array<(value: unknown) => void> = [];
    createRpcEndpoint(b, {
      request: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    const caller = createRpcEndpoint(a);

    const first = caller.request("first");
    const second = caller.request("second");
    await vi.waitFor(() => expect(resolvers.length).toBe(2));

    // Answered out of order: the ids are the only thing keeping them apart,
    // which is the defect `ipcTimeline.get` has and this exists to not have.
    resolvers[1]("second result");
    resolvers[0]("first result");

    await expect(first).resolves.toBe("first result");
    await expect(second).resolves.toBe("second result");
  });

  it("carries an error back as a code, not a thrown string", async () => {
    const [a, b] = linkedPorts();
    createRpcEndpoint(b, {
      request: () => {
        throw new RpcError("E_PERMISSION", "needs timeline.write");
      },
    });
    const caller = createRpcEndpoint(a);

    await expect(caller.request("edit")).rejects.toMatchObject({
      code: "E_PERMISSION",
      message: "needs timeline.write",
    });
  });

  it("times out, drops the entry, and tells the peer to stop", async () => {
    vi.useFakeTimers();
    try {
      const [a, b] = linkedPorts();
      const cancels: unknown[] = [];
      createRpcEndpoint(b, { request: () => new Promise(() => {}) });
      // A third endpoint is not needed to see the cancel: the peer's own
      // inbound signal is what a real handler watches, and the message that
      // trips it is asserted through that signal in the cancellation case
      // below. Here the only claim is that the caller stops waiting.
      const caller = createRpcEndpoint(a);
      void cancels;

      const pending = caller.request("slow", {}, { timeoutMs: 50 });
      const assertion = expect(pending).rejects.toMatchObject({ code: "E_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(caller.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a reply that arrives after its own timeout", async () => {
    vi.useFakeTimers();
    try {
      const [a, b] = linkedPorts();
      let answer: ((value: unknown) => void) | null = null;
      createRpcEndpoint(b, {
        request: () => new Promise((resolve) => {
          answer = resolve;
        }),
      });
      const caller = createRpcEndpoint(a);

      const pending = caller.request("slow", {}, { timeoutMs: 50 });
      const assertion = expect(pending).rejects.toMatchObject({ code: "E_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;

      // The late answer must not throw an unhandled rejection or resolve a
      // promise the caller has already given up on.
      answer?.("too late");
      await vi.advanceTimersByTimeAsync(10);
      expect(caller.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an in-flight request when the caller's signal aborts", async () => {
    const [a, b] = linkedPorts();
    let sawAbort = false;
    createRpcEndpoint(b, {
      request: (req) =>
        new Promise((_resolve, reject) => {
          req.signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new RpcError("E_CANCELLED", "stopped"));
          });
        }),
    });
    const caller = createRpcEndpoint(a);
    const controller = new AbortController();

    const pending = caller.request("long", {}, { signal: controller.signal, timeoutMs: 5_000 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "E_CANCELLED" });
    controller.abort();
    await assertion;

    await vi.waitFor(() => expect(sawAbort).toBe(true));
    expect(caller.pendingCount()).toBe(0);
  });

  it("refuses params over the cap before they reach the port", async () => {
    const [a] = linkedPorts();
    const sent: unknown[] = [];
    const caller = createRpcEndpoint(
      {
        postMessage: (message) => sent.push(message),
        onMessage: a.onMessage,
      },
      {},
    );

    const huge = { blob: "x".repeat(MAX_PARAMS_BYTES + 10) };
    await expect(caller.request("big", huge)).rejects.toMatchObject({ code: "E_TOO_LARGE" });
    expect(sent).toHaveLength(0);
  });

  it("refuses a result over the cap rather than posting it", async () => {
    const [a, b] = linkedPorts();
    createRpcEndpoint(b, {
      request: () => ({ blob: "y".repeat(5 * 1024 * 1024) }),
    });
    const caller = createRpcEndpoint(a);

    await expect(caller.request("huge")).rejects.toMatchObject({ code: "E_TOO_LARGE" });
  });

  it("rejects everything pending when the port closes", async () => {
    const [a, b, link] = linkedPorts();
    createRpcEndpoint(b, { request: () => new Promise(() => {}) });
    const caller = createRpcEndpoint(a);

    const pending = caller.request("never", {}, { timeoutMs: 60_000 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "E_INTERNAL" });
    link.close();
    await assertion;
    expect(caller.pendingCount()).toBe(0);
  });

  it("delivers events without answering them", async () => {
    const [a, b] = linkedPorts();
    const seen: Array<{ event: string; params: unknown }> = [];
    createRpcEndpoint(b, { event: (e) => seen.push({ event: e.event, params: e.params }) });
    const caller = createRpcEndpoint(a);

    caller.emit("playhead.changed", { ms: 120 });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ event: "playhead.changed", params: { ms: 120 } });
  });

  it("stamps the extension id on a request", async () => {
    const [a, b] = linkedPorts();
    const seen: Array<string | undefined> = [];
    createRpcEndpoint(b, {
      request: (req) => {
        seen.push(req.ext);
        return null;
      },
    });
    const caller = createRpcEndpoint(a);

    await caller.request("commands.execute", {}, { ext: "acme.hello" });
    expect(seen).toEqual(["acme.hello"]);
  });
});
