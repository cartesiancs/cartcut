/**
 * The main <-> renderer bridge, with Electron faked out.
 *
 * These cover the three ways `ipcTimeline.get` — the round trip this replaced —
 * gets it wrong, because an MCP server is precisely the caller that triggers
 * all three: it is long-lived, and Claude Code runs tool calls concurrently.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** A stand-in for `ipcMain` that lets a test play the renderer. */
const listeners = new Map<string, Function[]>();

const ipcMain = {
  on(channel: string, fn: Function) {
    const existing = listeners.get(channel) ?? [];
    existing.push(fn);
    listeners.set(channel, existing);
  },
  listenerCount(channel: string) {
    return (listeners.get(channel) ?? []).length;
  },
  emit(channel: string, ...args: unknown[]) {
    for (const fn of listeners.get(channel) ?? []) {
      fn({}, ...args);
    }
  },
};

vi.mock("electron", () => ({ ipcMain }));

const { attachBridge, requestEditor, isBridgeReady } = await import("./bridge");

/** Records what main sent, and lets the test reply as the renderer would. */
function fakeWebContents() {
  const sent: Array<{ id: string; command: string; params: unknown }> = [];
  const handlers = new Map<string, Function[]>();

  return {
    sent,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    send(_channel: string, id: string, command: string, params: unknown) {
      sent.push({ id, command, params });
    },
    once(event: string, fn: Function) {
      const existing = handlers.get(event) ?? [];
      existing.push(fn);
      handlers.set(event, existing);
    },
    destroy() {
      this.destroyed = true;
      for (const fn of handlers.get("destroyed") ?? []) {
        fn();
      }
    },
  };
}

function reply(id: string, response: unknown) {
  ipcMain.emit("agent:response", id, response);
}

beforeEach(() => {
  listeners.clear();
});

describe("attachBridge", () => {
  it("registers exactly one reply listener however often it runs", () => {
    // `ipcTimeline.get` adds a listener per *call* and removes none, so a
    // long-lived server accumulates them until every reply fans out to every
    // stale handler.
    attachBridge(fakeWebContents() as any);
    attachBridge(fakeWebContents() as any);
    attachBridge(fakeWebContents() as any);

    expect(ipcMain.listenerCount("agent:response")).toBe(1);
  });
});

describe("requestEditor", () => {
  it("resolves with the renderer's result", async () => {
    const wc = fakeWebContents();
    attachBridge(wc as any);

    const pending = requestEditor("list_clips", { limit: 5 });
    expect(wc.sent[0].command).toBe("list_clips");
    expect(wc.sent[0].params).toEqual({ limit: 5 });

    reply(wc.sent[0].id, { ok: true, result: { clips: [] } });
    await expect(pending).resolves.toEqual({ clips: [] });
  });

  it("routes concurrent calls by id, in whatever order they come back", async () => {
    // Without a request id the first reply settles every outstanding call —
    // so an out-of-order answer would give a tool someone else's data.
    const wc = fakeWebContents();
    attachBridge(wc as any);

    const first = requestEditor("get_clip", { elementId: "a" });
    const second = requestEditor("get_clip", { elementId: "b" });

    expect(wc.sent[0].id).not.toBe(wc.sent[1].id);

    reply(wc.sent[1].id, { ok: true, result: "B" });
    reply(wc.sent[0].id, { ok: true, result: "A" });

    await expect(first).resolves.toBe("A");
    await expect(second).resolves.toBe("B");
  });

  it("turns a renderer error into a rejection", async () => {
    const wc = fakeWebContents();
    attachBridge(wc as any);

    const pending = requestEditor("get_clip", { elementId: "ghost" });
    reply(wc.sent[0].id, { ok: false, error: 'No clip with id "ghost".' });

    await expect(pending).rejects.toThrow('No clip with id "ghost"');
  });

  it("times out instead of hanging forever", async () => {
    vi.useFakeTimers();
    const wc = fakeWebContents();
    attachBridge(wc as any);

    const pending = requestEditor("list_clips", {}, 50);
    const assertion = expect(pending).rejects.toThrow(/did not respond.*within 50ms/);

    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it("ignores a reply that arrives after its own timeout", async () => {
    vi.useFakeTimers();
    const wc = fakeWebContents();
    attachBridge(wc as any);

    const pending = requestEditor("list_clips", {}, 50);
    const assertion = expect(pending).rejects.toThrow(/did not respond/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;

    // The late reply must not throw or resolve anything.
    expect(() => reply(wc.sent[0].id, { ok: true, result: "late" })).not.toThrow();
    vi.useRealTimers();
  });

  it("refuses when there is no editor window", async () => {
    const wc = fakeWebContents();
    attachBridge(wc as any);
    wc.destroyed = true;

    await expect(requestEditor("list_clips")).rejects.toThrow(
      /editor window is not available/,
    );
    expect(isBridgeReady()).toBe(false);
  });

  it("fails everything in flight when the window closes", async () => {
    const wc = fakeWebContents();
    attachBridge(wc as any);

    const pending = requestEditor("list_clips");
    const assertion = expect(pending).rejects.toThrow(/closed before the request/);

    wc.destroy();

    await assertion;
    expect(isBridgeReady()).toBe(false);
  });
});

describe("when the window is replaced", () => {
  it("a stale window closing does not fail the live window's requests", async () => {
    const first = fakeWebContents();
    attachBridge(first as any);

    const second = fakeWebContents();
    attachBridge(second as any);

    const pending = requestEditor("list_clips");
    expect(second.sent).toHaveLength(1);

    // The old window finally goes away. It has no claim on this request.
    first.destroy();

    reply(second.sent[0].id, { ok: true, result: "still here" });
    await expect(pending).resolves.toBe("still here");
    expect(isBridgeReady()).toBe(true);
  });
});
