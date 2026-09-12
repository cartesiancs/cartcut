import { describe, expect, it, vi } from "vitest";
import {
  TranscribeSession,
  progressCopy,
  progressPercent,
  type TranscribePort,
  type TranscribeRequest,
} from "./transcribeSession";

/**
 * The job, against a fake port.
 *
 * The orderings are the point. Each of the four that looked arbitrary in the
 * panel has a case here, and each would have been silently reversible before.
 */

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  promise: Promise<unknown>;
};

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

function fakePort() {
  const started: Array<{ jobId: string; request: TranscribeRequest }> = [];
  const cancelled: string[] = [];
  const handlers: Array<(payload: unknown) => void> = [];
  let unsubscribes = 0;
  let pending = deferred();

  const port: TranscribePort = {
    start(jobId, request) {
      started.push({ jobId, request });
      return pending.promise;
    },
    cancel(jobId) {
      cancelled.push(jobId);
      return Promise.resolve({ ok: true });
    },
    onProgress(handler) {
      handlers.push(handler);
      return () => {
        unsubscribes += 1;
      };
    },
  };

  return {
    port,
    started,
    cancelled,
    get unsubscribes() {
      return unsubscribes;
    },
    /** Push a progress payload as main would. */
    emit(payload: unknown) {
      for (const handler of handlers) handler(payload);
    },
    settle: (value: unknown) => pending.resolve(value),
    fail: (error: unknown) => pending.reject(error),
    /** A fresh promise, for a second job. */
    reset() {
      pending = deferred();
    },
  };
}

const ids = (...values: string[]) => {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
};

const request: TranscribeRequest = {
  source: "file:///tmp/clip.mp4",
  method: "apple",
  locale: "ko-KR",
};

/** Words as main sends them. */
const wire = [[{ word: "hello", startMs: 0, endMs: 1000, confidence: 0.9 }]];

describe("TranscribeSession.run: the request", () => {
  it("mints an id and sends it with the request", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));

    const run = session.run(request, () => {});
    expect(host.started).toEqual([{ jobId: "job-1", request }]);

    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("has a live job id before start resolves, so Cancel can reach it", async () => {
    // The first-run model download is the long wait and it is inside `start`.
    // Minting afterwards would leave Cancel with nothing to send for minutes.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));

    const run = session.run(request, () => {});
    expect(session.jobId).toBe("job-1");

    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("opens at the extracting stage, at zero", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const seen: unknown[] = [];

    const run = session.run(request, () => seen.push(session.progress));
    expect(seen).toEqual([{ fraction: 0, stage: "extracting" }]);

    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("calls onStarted exactly once, before awaiting", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const onStarted = vi.fn();

    const run = session.run(request, onStarted);
    expect(onStarted).toHaveBeenCalledTimes(1);

    host.settle({ ok: true, lines: wire });
    await run;
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("sends the locale for the on-device recogniser", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run({ ...request, method: "apple", locale: "ko-KR" }, () => {});

    expect(host.started[0].request.locale).toBe("ko-KR");
    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("withholds the locale from OpenAI, which detects the language itself", async () => {
    // Sending one would imply it were honoured.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run({ ...request, method: "openai", locale: "ko-KR" }, () => {});

    expect(host.started[0].request.locale).toBeUndefined();
    expect(host.started[0].request.method).toBe("openai");
    host.settle({ ok: true, lines: wire });
    await run;
  });
});

describe("TranscribeSession.run: the outcome", () => {
  async function outcomeFor(value: unknown, reject = false) {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});
    if (reject) host.fail(value);
    else host.settle(value);
    return { outcome: await run, session, host };
  }

  it("answers the caption lines on success", async () => {
    const { outcome } = await outcomeFor({ ok: true, lines: wire });

    expect(outcome.kind).toBe("lines");
    expect(outcome.kind === "lines" && outcome.lines).toHaveLength(1);
    expect(outcome.kind === "lines" && outcome.lines[0].text).toBe("hello");
    // Seconds on this side of the wire.
    expect(outcome.kind === "lines" && outcome.lines[0].end).toBe(1);
  });

  it("answers zero lines when the transcript is missing", async () => {
    // A legal success with nothing in it — the panel opens with no captions.
    const { outcome } = await outcomeFor({ ok: true });
    expect(outcome).toEqual({ kind: "lines", lines: [] });
  });

  it("answers cancelled when main says so", async () => {
    const { outcome } = await outcomeFor({ ok: false, cancelled: true });
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("answers failed with main's message", async () => {
    const { outcome } = await outcomeFor({ ok: false, error: "no speech found" });
    expect(outcome).toEqual({ kind: "failed", message: "no speech found" });
  });

  it("answers failed with a default when there is no message", async () => {
    expect((await outcomeFor({ ok: false })).outcome).toEqual({
      kind: "failed",
      message: "Transcription failed.",
    });
  });

  it("treats anything but a literal true as failure", async () => {
    // It crosses IPC. A truthy-but-not-true `ok` must not be read as success.
    for (const ok of [1, "yes", {}, null]) {
      expect((await outcomeFor({ ok })).outcome.kind).toBe("failed");
    }
  });

  it("treats a missing result as failure", async () => {
    expect((await outcomeFor(undefined)).outcome).toEqual({
      kind: "failed",
      message: "Transcription failed.",
    });
  });

  it("treats a cancelled flag that is not literally true as failure", async () => {
    expect((await outcomeFor({ ok: false, cancelled: "yes" })).outcome.kind).toBe("failed");
  });

  it("turns a thrown error into failed, stringified", async () => {
    // The old local path swallowed every failure into an empty catch, so a server
    // that was not running looked exactly like a clip with no speech in it.
    const { outcome } = await outcomeFor(new Error("bridge gone"), true);
    expect(outcome).toEqual({ kind: "failed", message: "Error: bridge gone" });
  });

  it("clears the job id however it ends", async () => {
    for (const [value, reject] of [
      [{ ok: true, lines: wire }, false],
      [{ ok: false, cancelled: true }, false],
      [{ ok: false, error: "x" }, false],
      [new Error("boom"), true],
    ] as const) {
      const { session } = await outcomeFor(value, reject);
      expect(session.jobId).toBeNull();
    }
  });
});

describe("TranscribeSession.acceptProgress", () => {
  it("takes progress for the running job", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});

    expect(session.acceptProgress({ jobId: "job-1", fraction: 0.5, stage: "transcribing" }))
      .toBe(true);
    expect(session.progress).toEqual({ fraction: 0.5, stage: "transcribing" });

    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("drops progress for a different job", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});

    expect(session.acceptProgress({ jobId: "other", fraction: 0.9, stage: "transcribing" }))
      .toBe(false);
    expect(session.progress).toEqual({ fraction: 0, stage: "extracting" });

    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("drops everything once the job has finished", async () => {
    // `run` clears the id in a `finally`, before it has even looked at the
    // result, so a late progress event cannot move a bar that is gone.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});
    host.settle({ ok: true, lines: wire });
    await run;

    expect(session.acceptProgress({ jobId: "job-1", fraction: 1, stage: "transcribing" }))
      .toBe(false);
  });

  it("drops everything when no job is running", () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));

    expect(session.acceptProgress({ jobId: "job-1", fraction: 1, stage: "x" })).toBe(false);
    expect(session.acceptProgress(null)).toBe(false);
    expect(session.acceptProgress(undefined)).toBe(false);
    expect(session.acceptProgress({})).toBe(false);
  });

  it("reads a null fraction as zero, which is what queued sends", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});

    session.acceptProgress({ jobId: "job-1", fraction: null, stage: "queued" });
    expect(session.progress).toEqual({ fraction: 0, stage: "queued" });

    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("accepts stages in any order, because main's are not monotonic", async () => {
    // The renderer opens at `extracting` and main can immediately replace it with
    // `queued`, so extracting -> queued -> extracting -> transcribing is legal.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});

    for (const stage of ["queued", "extracting", "downloading", "transcribing"]) {
      expect(session.acceptProgress({ jobId: "job-1", fraction: 0.1, stage })).toBe(true);
      expect(session.progress.stage).toBe(stage);
    }

    host.settle({ ok: true, lines: wire });
    await run;
  });
});

describe("TranscribeSession.subscribe", () => {
  it("notifies only for our own job", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const onChange = vi.fn();
    session.subscribe(onChange);

    const run = session.run(request, () => {});
    host.emit({ jobId: "job-1", fraction: 0.3, stage: "transcribing" });
    host.emit({ jobId: "someone-else", fraction: 0.9, stage: "transcribing" });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(session.progress).toEqual({ fraction: 0.3, stage: "transcribing" });

    host.settle({ ok: true, lines: wire });
    await run;
  });

  it("hands back the port's unsubscribe", () => {
    // The loop used to outlive the component; an unremoved listener holding
    // `this` is the same leak class.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));

    session.subscribe(() => {})();
    expect(host.unsubscribes).toBe(1);
  });
});

describe("TranscribeSession.requestCancel", () => {
  it("sends the live job id", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});

    session.requestCancel();
    expect(host.cancelled).toEqual(["job-1"]);

    host.settle({ ok: false, cancelled: true });
    expect((await run).kind).toBe("cancelled");
  });

  it("sends nothing once the job is over", async () => {
    // Main ignores an unknown id, so the only visible effect of getting this
    // wrong is that Cancel appears to work and does not.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});
    host.settle({ ok: true, lines: wire });
    await run;

    session.requestCancel();
    expect(host.cancelled).toEqual([]);
  });

  it("sends nothing after clear, which is the ordering trap", () => {
    // `cancelAnalysis` must read the id *before* `_endAnalysis` nulls it.
    // Reversing those two lines sends nothing and main silently ignores it.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    void session.run(request, () => {});

    session.clear();
    session.requestCancel();
    expect(host.cancelled).toEqual([]);
  });

  it("sends nothing before any job has started", () => {
    const host = fakePort();
    new TranscribeSession(host.port, ids("job-1")).requestCancel();
    expect(host.cancelled).toEqual([]);
  });

  it("reaches main during a model download, which is the whole reason", async () => {
    // `start` does not resolve until the download finishes, so this is the only
    // window in which Cancel matters — and the id exists throughout it.
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1"));
    const run = session.run(request, () => {});

    session.acceptProgress({ jobId: "job-1", fraction: 0.2, stage: "downloading" });
    expect(session.progress.stage).toBe("downloading");

    session.requestCancel();
    expect(host.cancelled).toEqual(["job-1"]);

    host.settle({ ok: false, cancelled: true });
    await run;
  });
});

describe("two jobs in one session", () => {
  it("uses a fresh id and ignores the first job's late progress", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1", "job-2"));

    const first = session.run(request, () => {});
    host.settle({ ok: true, lines: wire });
    await first;

    host.reset();
    const second = session.run(request, () => {});
    expect(host.started.map((s) => s.jobId)).toEqual(["job-1", "job-2"]);
    expect(session.jobId).toBe("job-2");

    expect(session.acceptProgress({ jobId: "job-1", fraction: 1, stage: "x" })).toBe(false);
    expect(session.acceptProgress({ jobId: "job-2", fraction: 0.5, stage: "transcribing" }))
      .toBe(true);

    host.settle({ ok: true, lines: wire });
    await second;
  });

  it("resets the bar for the second job", async () => {
    const host = fakePort();
    const session = new TranscribeSession(host.port, ids("job-1", "job-2"));

    const first = session.run(request, () => {});
    session.acceptProgress({ jobId: "job-1", fraction: 0.9, stage: "transcribing" });
    host.settle({ ok: true, lines: wire });
    await first;

    host.reset();
    const second = session.run(request, () => {});
    expect(session.progress).toEqual({ fraction: 0, stage: "extracting" });

    host.settle({ ok: true, lines: wire });
    await second;
  });
});

describe("progressCopy", () => {
  it("names the download and says it happens once", () => {
    expect(progressCopy("downloading")).toEqual({
      title: "Downloading the language model...",
      note: "This happens once per language, and the model stays on this Mac.",
    });
  });

  it("names extraction, and promises the audio stays put", () => {
    expect(progressCopy("extracting")).toEqual({
      title: "Extracting audio...",
      note: "The audio never leaves your computer.",
    });
  });

  it("names transcription", () => {
    expect(progressCopy("transcribing").title).toBe("Transcribing...");
  });

  it("shows QUEUED as 'Transcribing...', which is a pinned defect", () => {
    // Findings F13. Main sends `queued` with a null fraction when a job waits
    // behind another, and there is no branch for it — so a queued job claims to
    // be transcribing at 0%, indistinguishable from one that has just started.
    // Pinned rather than fixed; flip this test when the branch is added.
    expect(progressCopy("queued")).toEqual(progressCopy("transcribing"));
    expect(progressCopy("queued").title).toBe("Transcribing...");
  });

  it("falls through for an unknown or empty stage", () => {
    // The initial state is "", and a stage main adds later must not render blank.
    expect(progressCopy("").title).toBe("Transcribing...");
    expect(progressCopy("something-new").title).toBe("Transcribing...");
  });

  it("always says something in both slots", () => {
    for (const stage of ["", "queued", "extracting", "downloading", "transcribing", "?"]) {
      const copy = progressCopy(stage);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.note.length).toBeGreaterThan(0);
    }
  });
});

describe("progressPercent", () => {
  it("rounds to a whole percent", () => {
    expect(progressPercent(0.4376190476190476)).toBe(44);
    expect(progressPercent(0)).toBe(0);
    expect(progressPercent(1)).toBe(100);
  });

  it("never emits the long fraction the playback bar does", () => {
    // Findings F19: the playback bar passes `fraction * 100` unrounded, so it
    // gets a CSS width like 43.761904761904766 while this one gets 44.
    expect(Number.isInteger(progressPercent(0.4376190476190476))).toBe(true);
  });
});
