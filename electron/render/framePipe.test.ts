import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import {
  cancelSession,
  FrameSizeError,
  writeFrame,
  type ExportSession,
} from "./framePipe";

/**
 * A stdin that reports "buffer full" until told otherwise, so the drain path
 * can be driven deterministically.
 */
class FakeStdin extends EventEmitter {
  writable = true;
  /** What the next `write` returns; false means "wait for drain". */
  accepts = true;
  written: Buffer[] = [];

  write(buffer: Buffer): boolean {
    this.written.push(buffer);
    return this.accepts;
  }
}

class FakeProcess extends EventEmitter {
  stdin = new FakeStdin();
  killed: string[] = [];

  kill(signal: string) {
    this.killed.push(signal);
    return true;
  }
}

function makeSession(overrides: Partial<ExportSession> = {}): ExportSession {
  const process = new FakeProcess();
  return {
    id: "export-test",
    process: process as unknown as ExportSession["process"],
    destination: "/tmp/out.mp4",
    expectedFrameBytes: 0,
    framesWritten: 0,
    stderrTail: [],
    cancelled: false,
    finished: false,
    drain: null,
    ...overrides,
  };
}

const frame = (bytes: number) => Buffer.alloc(bytes);

describe("writeFrame", () => {
  it("resolves immediately while the pipe still has room", async () => {
    const session = makeSession();
    await expect(writeFrame(session, frame(8))).resolves.toBeUndefined();
    expect(session.framesWritten).toBe(1);
  });

  it("stays pending until 'drain' once the pipe is full", async () => {
    const session = makeSession();
    const stdin = session.process.stdin as unknown as FakeStdin;
    stdin.accepts = false;

    const pending = writeFrame(session, frame(8));
    const settled = vi.fn();
    void pending.then(settled);

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    stdin.emit("drain");
    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects rather than hanging when FFmpeg dies mid-frame", async () => {
    // The drain event can only fire while something is reading the pipe, so a
    // dead process would otherwise wedge the frame loop forever.
    const session = makeSession();
    const stdin = session.process.stdin as unknown as FakeStdin;
    stdin.accepts = false;

    const pending = writeFrame(session, frame(8));
    session.process.emit("close", 1, null);

    await expect(pending).rejects.toThrow(/exited while a frame was in flight/);
  });

  it("shares one drain promise across concurrent writers", async () => {
    const session = makeSession();
    const stdin = session.process.stdin as unknown as FakeStdin;
    stdin.accepts = false;

    const first = writeFrame(session, frame(8));
    const second = writeFrame(session, frame(8));
    expect(second).toBe(first);

    stdin.emit("drain");
    await expect(first).resolves.toBeUndefined();
    expect(session.drain).toBeNull();
  });

  it("rejects a frame whose length does not match the declared stride", async () => {
    // rawvideo is unframed: a short write offsets every frame after it, all
    // the way to the end of the file, with no error from FFmpeg.
    const session = makeSession({ expectedFrameBytes: 24 });

    await expect(writeFrame(session, frame(23))).rejects.toBeInstanceOf(
      FrameSizeError,
    );
    await expect(writeFrame(session, frame(25))).rejects.toBeInstanceOf(
      FrameSizeError,
    );
    expect(session.framesWritten).toBe(0);
    await expect(writeFrame(session, frame(24))).resolves.toBeUndefined();
  });

  it("does not check length when the pipe is self-delimiting", async () => {
    const session = makeSession({ expectedFrameBytes: 0 });
    await expect(writeFrame(session, frame(7))).resolves.toBeUndefined();
  });

  it("rejects once the process has finished", async () => {
    const session = makeSession({ finished: true });
    await expect(writeFrame(session, frame(8))).rejects.toThrow(
      /no longer accepting frames/,
    );
  });
});

describe("cancelSession", () => {
  it("frees the session slot synchronously, before the exit is reaped", () => {
    // The kill is asynchronous. Waiting for `close` to mark the session
    // finished meant "cancel, then export again" was refused with "an export
    // is already running" for as long as reaping took.
    const session = makeSession();
    cancelSession(session);

    expect(session.finished).toBe(true);
    expect(session.cancelled).toBe(true);
    expect(
      (session.process as unknown as FakeProcess).killed,
    ).toEqual(["SIGKILL"]);
  });

  it("refuses further frames immediately", async () => {
    const session = makeSession();
    cancelSession(session);
    await expect(writeFrame(session, frame(8))).rejects.toThrow(
      /no longer accepting frames/,
    );
  });

  it("is idempotent", () => {
    const session = makeSession();
    cancelSession(session);
    cancelSession(session);
    expect((session.process as unknown as FakeProcess).killed).toEqual([
      "SIGKILL",
    ]);
  });
});
