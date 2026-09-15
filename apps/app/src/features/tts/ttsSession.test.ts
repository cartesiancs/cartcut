/**
 * One synthesis, against a fake bridge.
 *
 * The orderings are the point, and they are the same three
 * `caption/transcribeSession.test.ts` cares about: the job id exists before
 * `start` is awaited, the tray row is always removed, and a cancelled or
 * failed job places nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { backgroundTaskStore } from "../../states/backgroundTaskStore";
import { useTimelineStore } from "../../states/timelineStore";
import type { MediaProber } from "../element/mediaProbe";
import { speak, trayLabel } from "./ttsSession";
import type {
  TtsPort,
  TtsProgress,
  TtsStartReply,
  TtsStartRequest,
} from "./ttsPort";

const REQUEST: TtsStartRequest = {
  text: "Hello there.",
  voice: "M1",
  lang: "en",
  speed: 1.05,
  steps: 4,
};

/** A probe that measures any file as two seconds of audio, with no DOM. */
const prober: MediaProber = {
  image: async () => ({ width: 1, height: 1 }),
  gif: async () => ({ width: 1, height: 1 }),
  video: async () => ({ width: 1, height: 1, durationMs: 2000, hasAudio: true }),
  audio: async () => ({ durationMs: 2000 }),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A stand-in for `electronAPI.req.tts`.
 *
 * `start` is held open until the test settles it, so assertions can be made
 * about the world *while* a job is in flight, which is where the orderings
 * that matter actually live.
 */
function fakePort() {
  const started: { jobId: string; request: TtsStartRequest }[] = [];
  const cancelled: string[] = [];
  const handlers: ((payload: TtsProgress) => void)[] = [];
  let pending = deferred<TtsStartReply>();

  const port: TtsPort = {
    availability: async () => ({
      ok: true,
      totalBytes: 1,
      voices: ["M1"],
      repo: "r",
      license: "l",
    }),
    download: async () => ({ ok: true, downloaded: [] }),
    cancelDownload: async () => ({}),
    start: (jobId, request) => {
      started.push({ jobId, request });
      return pending.promise;
    },
    cancel: async (jobId) => {
      cancelled.push(jobId);
      return {};
    },
    onProgress: (handler) => {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) {
          handlers.splice(index, 1);
        }
      };
    },
  };

  return {
    port,
    started,
    cancelled,
    handlers,
    emit: (payload: TtsProgress) => handlers.forEach((h) => h(payload)),
    settle: (reply: TtsStartReply) => {
      pending.resolve(reply);
      pending = deferred<TtsStartReply>();
    },
  };
}

const ok = (path = "/tmp/line.wav"): TtsStartReply => ({
  ok: true,
  path,
  durationMs: 2000,
  sampleRate: 44100,
});

beforeEach(() => {
  for (const task of [...backgroundTaskStore.getState().tasks]) {
    backgroundTaskStore.getState().remove(task.id);
  }
});

describe("trayLabel", () => {
  it("quotes a short line whole", () => {
    expect(trayLabel("Hello")).toBe('Speaking "Hello"');
  });

  it("clips a long script so it cannot fill the tray", () => {
    const label = trayLabel("word ".repeat(50));
    expect(label.length).toBeLessThan(48);
    expect(label).toContain("...");
  });

  it("flattens newlines rather than breaking the row", () => {
    expect(trayLabel("one\n\ntwo")).toBe('Speaking "one two"');
  });

  it("says something for text with nothing in it", () => {
    expect(trayLabel("   ")).toBe("Speaking");
  });
});

describe("speak", () => {
  /**
   * The ordering the whole file exists for. A first run spends its longest
   * stretch loading the model, and a tray row that only appeared once `start`
   * resolved would offer Cancel exactly when it was no longer needed.
   */
  it("adds a cancellable tray row before start resolves", async () => {
    const fake = fakePort();
    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "job-1",
      prober,
    });

    await Promise.resolve();
    const task = backgroundTaskStore
      .getState()
      .tasks.find((t) => t.id === "job-1");
    expect(task).toBeDefined();
    expect(task?.kind).toBe("tts");
    expect(task?.cancel).toBeTypeOf("function");

    task?.cancel?.();
    expect(fake.cancelled).toEqual(["job-1"]);

    fake.settle({ ok: false, cancelled: true });
    await running;
  });

  it("passes the job id it minted to start", async () => {
    const fake = fakePort();
    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "job-7",
      prober,
    });
    await Promise.resolve();
    expect(fake.started[0].jobId).toBe("job-7");
    expect(fake.started[0].request).toEqual(REQUEST);

    fake.settle({ ok: false, cancelled: true });
    await running;
  });

  it("places the finished file on the timeline", async () => {
    const fake = fakePort();
    const before = Object.keys(
      useTimelineStore.getState().getDocument().elements,
    ).length;

    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "job-2",
      prober,
    });
    await Promise.resolve();
    fake.settle(ok());
    const outcome = await running;

    expect(outcome.kind).toBe("placed");
    const elements = useTimelineStore.getState().getDocument().elements;
    expect(Object.keys(elements).length).toBe(before + 1);
    if (outcome.kind === "placed") {
      expect(elements[outcome.elementId].filetype).toBe("audio");
    }
  });

  it("reports a cancelled job and places nothing", async () => {
    const fake = fakePort();
    const before = Object.keys(
      useTimelineStore.getState().getDocument().elements,
    ).length;

    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "job-3",
      prober,
    });
    await Promise.resolve();
    fake.settle({ ok: false, cancelled: true });

    expect((await running).kind).toBe("cancelled");
    expect(
      Object.keys(useTimelineStore.getState().getDocument().elements).length,
    ).toBe(before);
  });

  it("reports the failure message and places nothing", async () => {
    const fake = fakePort();
    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "job-4",
      prober,
    });
    await Promise.resolve();
    fake.settle({ ok: false, error: "The voice model is not installed." });

    const outcome = await running;
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain(
      "not installed",
    );
  });

  /**
   * A tray row left behind is a Cancel button for a job that no longer exists,
   * and there is no way for the user to clear it.
   */
  it.each<[string, TtsStartReply]>([
    ["success", ok()],
    ["cancel", { ok: false, cancelled: true }],
    ["failure", { ok: false, error: "nope" }],
  ])("removes the tray row after %s", async (_name, reply) => {
    const fake = fakePort();
    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "job-5",
      prober,
    });
    await Promise.resolve();
    fake.settle(reply);
    await running;

    expect(
      backgroundTaskStore.getState().tasks.find((t) => t.id === "job-5"),
    ).toBeUndefined();
  });

  it("removes the tray row when start rejects outright", async () => {
    const port = {
      ...fakePort().port,
      start: () => Promise.reject(new Error("bridge died")),
    } as TtsPort;

    const outcome = await speak(REQUEST, {
      port,
      mintId: () => "job-6",
      prober,
    });

    expect(outcome.kind).toBe("failed");
    expect(
      backgroundTaskStore.getState().tasks.find((t) => t.id === "job-6"),
    ).toBeUndefined();
  });

  it("forwards only its own job's progress to the caller", async () => {
    const fake = fakePort();
    const seen: string[] = [];
    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "mine",
      onProgress: (_f, stage) => seen.push(stage),
      prober,
    });
    await Promise.resolve();

    fake.emit({ jobId: "someone-else", fraction: 0.5, stage: "wrong" });
    fake.emit({ jobId: "mine", fraction: 0.5, stage: "synthesizing" });

    fake.settle(ok());
    await running;

    expect(seen).toEqual(["synthesizing"]);
  });

  it("unsubscribes its progress listener when the job ends", async () => {
    const fake = fakePort();
    const running = speak(REQUEST, {
      port: fake.port,
      mintId: () => "job-8",
      onProgress: () => {},
      prober,
    });
    await Promise.resolve();
    const during = fake.handlers.length;

    fake.settle(ok());
    await running;

    expect(fake.handlers.length).toBeLessThan(during);
  });
});
