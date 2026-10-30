/**
 * The browser's speech port, against a fake worker.
 *
 * The orderings are `ipcTts.ts`'s and matter for its reasons: one job at a
 * time, a cancel that stops the worker rather than asking it to, a worker that
 * dies taking its job with it rather than leaving it pending forever, and a
 * worker that is let go after a minute idle. The one rule of its own is parity:
 * the request the worker receives carries the seed the **desktop** would have
 * used, which is what makes a line sound the same in either build.
 */

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { speechKey } from "../../../../../../electron/lib/tts/ttsCacheKey";
import { seedFor } from "../../../../../../electron/lib/tts/ttsKeyInput";
import {
  VOICE_IDS,
  downloadUrl,
  type ModelFile,
} from "../../../../../../electron/lib/tts/ttsManifest";
import type { TtsProgress, TtsStartRequest } from "../ttsPort";
import type { FetchPort, ModelCache } from "./webModelStore";
import {
  IDLE_SHUTDOWN_MS,
  createWebTtsPort,
  type Timers,
  type WebTtsDeps,
  type WorkerHandlers,
} from "./webTtsPort";
import type { WebWorkerCommand, WebWorkerEvent } from "./webTtsProtocol";

const sha = (algorithm: string) => (data: Uint8Array | string) =>
  createHash(algorithm).update(data).digest("hex");

function fileOf(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  return { path, bytes: bytes.byteLength, sha256: sha("sha256")(bytes), content: bytes };
}

const FILES = [fileOf("onnx/a.onnx", "aaaa"), fileOf("voice_styles/M1.json", "bbbbbbbb")];

const REQUEST: TtsStartRequest = {
  text: "안녕하세요.",
  voice: "F2",
  lang: "ko",
  speed: 1.05,
  steps: 4,
};

type FakeWorker = {
  handlers: WorkerHandlers;
  posts: WebWorkerCommand[];
  terminated: boolean;
};

/** Timers the test fires by hand. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers: Timers = {
    set: (callback, ms) => {
      expect(ms).toBe(IDLE_SHUTDOWN_MS);
      pending.set(++next, callback);
      return next;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending,
    fireAll: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function setup(options: { installed?: ModelFile[] } = {}) {
  const stored = new Map<string, Uint8Array>();
  for (const file of options.installed ?? FILES) {
    stored.set(downloadUrl(file), (file as (typeof FILES)[number]).content);
  }
  const cache: ModelCache = {
    keys: async () => [...stored.keys()],
    put: async (url, bytes) => {
      stored.set(url, bytes);
    },
    read: async (url) => stored.get(url)?.slice().buffer ?? null,
  };

  const workers: FakeWorker[] = [];
  const registered: { name: string; bytes: number[] }[] = [];
  const pruned = vi.fn(async () => []);
  const clock = manualTimers();

  const fetch: FetchPort = async (url) => {
    const file = FILES.find((one) => downloadUrl(one) === url)!;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(stream) {
          stream.enqueue(file.content);
          stream.close();
        },
      }),
    };
  };

  const deps: WebTtsDeps = {
    openCache: async () => cache,
    fetch,
    digest: async (bytes) => sha("sha256")(bytes),
    sha1: async (text) => sha("sha1")(text),
    spawnWorker: (handlers) => {
      const worker: FakeWorker = { handlers, posts: [], terminated: false };
      workers.push(worker);
      return {
        post: (command) => worker.posts.push(command),
        terminate: () => {
          worker.terminated = true;
        },
      };
    },
    register: (wav, name) => {
      registered.push({ name, bytes: [...wav] });
      return `blob:test/${registered.length}#${name}`;
    },
    pruneStale: pruned,
    files: FILES,
    timers: clock.timers,
  };

  const port = createWebTtsPort(deps);
  const progress: TtsProgress[] = [];
  port.onProgress((payload) => progress.push(payload));

  /** Answer a posted job the way the real worker does. */
  const finish = (worker: FakeWorker, jobId: string, wav = [1, 2, 3]) =>
    worker.handlers.onEvent({
      type: "done",
      jobId,
      ok: true,
      wav: new Uint8Array(wav).buffer,
      durationMs: 1500,
      sampleRate: 44100,
    });
  const emit = (worker: FakeWorker, event: WebWorkerEvent) =>
    worker.handlers.onEvent(event);

  return { port, workers, registered, progress, pruned, clock, stored, finish, emit };
}

describe("availability", () => {
  it("says the model is kept in the browser, with the desktop's voices", async () => {
    const { port, pruned } = setup();
    const reply = await port.availability();
    expect(reply).toMatchObject({ ok: true, storage: "browser" });
    expect(reply.voices).toEqual(VOICE_IDS);
    expect(pruned).toHaveBeenCalled();
  });

  it("tells a first run from an interrupted one", async () => {
    expect(await setup({ installed: [] }).port.availability()).toMatchObject({
      ok: false,
      reason: "models_not_installed",
      presentBytes: 0,
    });
    expect(await setup({ installed: [FILES[1]] }).port.availability()).toMatchObject({
      ok: false,
      reason: "models_incomplete",
      presentBytes: FILES[1].bytes,
    });
  });
});

describe("start", () => {
  it("hands the worker a coerced request seeded exactly as the desktop seeds it", async () => {
    const { port, workers, finish } = setup();
    const reply = port.start("job-1", { ...REQUEST, steps: 40 });

    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));
    const posted = workers[0].posts[0];
    const coerced = { ...REQUEST, steps: 8 };
    expect(posted).toEqual({
      type: "synthesize",
      jobId: "job-1",
      request: { ...coerced, seed: seedFor(speechKey(coerced)) },
    });

    finish(workers[0], "job-1");
    expect(await reply).toMatchObject({ ok: true, durationMs: 1500, sampleRate: 44100 });
  });

  it("registers the finished file under the desktop's key and answers its path", async () => {
    const { port, workers, registered, finish } = setup();
    const reply = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));
    finish(workers[0], "job-1", [7, 8, 9]);

    const answer = await reply;
    const name = `speech-${speechKey(REQUEST)}.wav`;
    expect(registered).toEqual([{ name, bytes: [7, 8, 9] }]);
    expect(answer).toEqual({
      ok: true,
      path: `blob:test/1#${name}`,
      durationMs: 1500,
      sampleRate: 44100,
    });
  });

  it("answers a line already spoken this session without waking the worker", async () => {
    const { port, workers, registered, finish } = setup();
    const first = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));
    finish(workers[0], "job-1");
    const firstReply = await first;

    const again = await port.start("job-2", { ...REQUEST });
    expect(again).toEqual(firstReply);
    expect(workers[0].posts).toHaveLength(1);
    expect(registered).toHaveLength(1);
  });

  it("relays the worker's progress under the job's id", async () => {
    const { port, workers, progress, emit, finish } = setup();
    const reply = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));

    emit(workers[0], { type: "progress", jobId: "job-1", fraction: 0, stage: "loading" });
    emit(workers[0], { type: "progress", jobId: "job-1", fraction: 0, stage: "loading" });
    emit(workers[0], { type: "progress", jobId: "job-1", fraction: 0.5, stage: "synthesizing" });
    finish(workers[0], "job-1");
    await reply;

    // The repeat is dropped; the stage change is not.
    expect(progress).toEqual([
      { jobId: "job-1", fraction: 0, stage: "loading" },
      { jobId: "job-1", fraction: 0.5, stage: "synthesizing" },
    ]);
  });

  it("refuses without starting a worker when the model is not installed", async () => {
    const { port, workers } = setup({ installed: [FILES[0]] });
    const reply = await port.start("job-1", REQUEST);
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.error).toContain("not installed");
    expect(workers).toHaveLength(0);
  });

  it("passes the worker's own failure through and keeps the worker", async () => {
    const { port, workers, emit } = setup();
    const reply = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));
    emit(workers[0], { type: "done", jobId: "job-1", ok: false, error: "Nothing to say" });
    expect(await reply).toEqual({ ok: false, error: "Nothing to say" });
    expect(workers[0].terminated).toBe(false);
  });

  it("settles a job whose worker died, and starts a fresh worker for the next", async () => {
    const { port, workers, finish } = setup();
    const reply = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));
    workers[0].handlers.onFailure("out of memory");

    const answer = await reply;
    expect(answer.ok === false && answer.error).toContain("out of memory");
    expect(workers[0].terminated).toBe(true);

    const next = port.start("job-2", { ...REQUEST, text: "Something else." });
    await vi.waitFor(() => expect(workers[1]?.posts).toHaveLength(1));
    finish(workers[1], "job-2");
    expect((await next).ok).toBe(true);
  });
});

describe("one job at a time", () => {
  it("queues the second job, says so, and posts it once the first is done", async () => {
    const { port, workers, progress, finish } = setup();
    const first = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));

    const second = port.start("job-2", { ...REQUEST, voice: "M3" });
    expect(progress).toContainEqual({ jobId: "job-2", fraction: null, stage: "queued" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workers[0].posts).toHaveLength(1);

    finish(workers[0], "job-1");
    await first;
    await vi.waitFor(() => expect(workers[0].posts).toHaveLength(2));
    expect(workers[0].posts[1].jobId).toBe("job-2");
    finish(workers[0], "job-2");
    expect((await second).ok).toBe(true);
  });

  it("cancels the running job by stopping the worker", async () => {
    const { port, workers, finish } = setup();
    const reply = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));

    await port.cancel("job-1");
    expect(await reply).toEqual({ ok: false, cancelled: true });
    expect(workers[0].terminated).toBe(true);

    // A late answer from the stopped worker places nothing.
    finish(workers[0], "job-1");
    const next = port.start("job-2", REQUEST);
    await vi.waitFor(() => expect(workers[1]?.posts).toHaveLength(1));
  });

  it("cancels a queued job without it ever reaching the worker", async () => {
    const { port, workers, finish } = setup();
    const first = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));
    const second = port.start("job-2", { ...REQUEST, voice: "M3" });

    await port.cancel("job-2");
    expect(await second).toEqual({ ok: false, cancelled: true });

    finish(workers[0], "job-1");
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workers[0].posts.map((post) => post.jobId)).toEqual(["job-1"]);
  });

  it("cancels a job still being keyed, before anything is posted", async () => {
    const { port, workers } = setup();
    const reply = port.start("job-1", REQUEST);
    await port.cancel("job-1");
    expect(await reply).toEqual({ ok: false, cancelled: true });
    expect(workers).toHaveLength(0);
  });
});

describe("the idle worker", () => {
  it("is let go a minute after its last job, and the timer is cleared by the next", async () => {
    const { port, workers, clock, finish } = setup();
    const first = port.start("job-1", REQUEST);
    await vi.waitFor(() => expect(workers[0]?.posts).toHaveLength(1));
    finish(workers[0], "job-1");
    await first;
    expect(clock.pending.size).toBe(1);

    const second = port.start("job-2", { ...REQUEST, voice: "M3" });
    await vi.waitFor(() => expect(workers[0].posts).toHaveLength(2));
    expect(clock.pending.size).toBe(0);
    finish(workers[0], "job-2");
    await second;

    clock.fireAll();
    expect(workers[0].terminated).toBe(true);
  });
});

describe("download", () => {
  it("fills the cache and reports under the downloading stage", async () => {
    const { port, progress, stored } = setup({ installed: [] });
    const reply = await port.download("dl-1");
    expect(reply).toEqual({ ok: true, downloaded: FILES.map((file) => file.path) });
    expect(stored.size).toBe(FILES.length);
    expect(progress.every((p) => p.jobId === "dl-1" && p.stage === "downloading")).toBe(true);
    expect(progress.at(-1)?.fraction).toBe(1);
    expect((await port.availability()).ok).toBe(true);
  });

  it("runs one download at a time", async () => {
    const { port } = setup({ installed: [] });
    const first = port.download("dl-1");
    const second = await port.download("dl-2");
    expect(second).toEqual({ ok: false, error: "A model download is already running." });
    expect((await first).ok).toBe(true);
  });

  it("answers cancelled when the user stops it", async () => {
    const { port } = setup({ installed: [] });
    const reply = port.download("dl-1");
    await port.cancelDownload("dl-1");
    expect(await reply).toEqual({ ok: false, cancelled: true });
  });
});
