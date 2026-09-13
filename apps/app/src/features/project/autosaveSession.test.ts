import { beforeEach, describe, expect, it } from "vitest";
import {
  AUTOSAVE_EXPORT_OVERRIDE_MS,
  AUTOSAVE_EXPORT_POLL_MS,
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  AutosaveSession,
  type AutosaveSnapshot,
  type AutosaveWriteResult,
} from "./autosaveSession";

/**
 * The state machine, driven by an injected clock.
 *
 * **Not `vi.useFakeTimers`.** The `caption/previewLoop.test.ts` arrangement
 * instead: a fake that hands back ids and lets the test decide when each
 * callback runs, and whose `fire` asserts the id is armed so a mis-driven test
 * fails loudly rather than quietly doing nothing. That is what makes "the
 * ceiling is still armed after five changes" expressible at all — with real
 * timers you can only observe what happened, not what is pending.
 *
 * `LOAD-BEARING` marks every case whose absence would silently lose the user's
 * work. There are six, and they are the reason this file is long:
 *
 * - the ceiling actually firing during continuous editing;
 * - a change arriving mid-write not being swallowed;
 * - a rejected write not clearing dirt;
 * - a `{ ok: false }` write not clearing dirt either;
 * - a save dropping the ring only after the bytes landed;
 * - a recovery *not* dropping the ring it came from.
 */

type Armed = { id: number; ms: number; fn: () => void };

function fakeClock() {
  let nextId = 1;
  let now = 1_000_000;
  const armed = new Map<number, Armed>();

  return {
    clock: {
      now: () => now,
      setTimer: (ms: number, fn: () => void) => {
        const id = nextId++;
        armed.set(id, { id, ms, fn });
        return id;
      },
      clearTimer: (id: number) => {
        armed.delete(id);
      },
    },
    /** Every pending timer, as `{ id, ms }`. */
    pending: () => [...armed.values()].map(({ id, ms }) => ({ id, ms })),
    /** The delays currently armed. */
    delays: () => [...armed.values()].map((a) => a.ms).sort((a, b) => a - b),
    advance: (ms: number) => {
      now += ms;
    },
    /** Fire one armed timer by delay, asserting it was armed. */
    fire: (ms: number) => {
      const hit = [...armed.values()].find((a) => a.ms === ms);
      if (hit == null) {
        throw new Error(
          `No timer armed at ${ms}ms; armed: ${[...armed.values()]
            .map((a) => a.ms)
            .join(", ")}`,
        );
      }
      armed.delete(hit.id);
      now += ms;
      hit.fn();
    },
  };
}

function fakeWriter() {
  const calls: Array<{
    key: string;
    bytes: Uint8Array;
    meta: { label: string; anchor: string | null };
  }> = [];
  const drops: string[][] = [];
  let answer: AutosaveWriteResult | "reject" = {
    ok: true,
    file: "/cache/a.ngt",
    writtenAtMs: 1,
  };
  let pending: { resolve: (r: AutosaveWriteResult) => void } | null = null;
  let hold = false;

  return {
    writer: {
      write: async (request: any) => {
        calls.push(request);
        if (hold) {
          return new Promise<AutosaveWriteResult>((resolve) => {
            pending = { resolve };
          });
        }
        if (answer === "reject") {
          throw new Error("disk on fire");
        }
        return answer;
      },
      dropRings: async (keys: string[]) => {
        drops.push(keys);
        return undefined;
      },
    },
    calls,
    drops,
    succeed: () => {
      answer = { ok: true, file: "/cache/a.ngt", writtenAtMs: 1 };
    },
    failSoft: (error = "ENOSPC") => {
      answer = { ok: false, error };
    },
    failHard: () => {
      answer = "reject";
    },
    /** Make the next write hang until `release` is called. */
    holdNext: () => {
      hold = true;
    },
    release: (result?: AutosaveWriteResult) => {
      hold = false;
      pending?.resolve(
        result ?? { ok: true, file: "/cache/a.ngt", writtenAtMs: 1 },
      );
      pending = null;
    },
  };
}

function fakeSource() {
  let digest = "d1";
  let baseline: string | null = "saved";
  let available = true;
  let zips = 0;

  const state = {
    source: {
      snapshot: (): AutosaveSnapshot | null =>
        available
          ? {
              digest,
              baseline,
              key: "f-abc-Film",
              label: "Film.ngt",
              anchor: "/Users/me/Film.ngt",
              bytes: async () => {
                zips += 1;
                return new Uint8Array([1, 2, 3]);
              },
            }
          : null,
    },
    setDigest: (value: string) => {
      digest = value;
    },
    setBaseline: (value: string | null) => {
      baseline = value;
    },
    hide: () => {
      available = false;
    },
    show: () => {
      available = true;
    },
    zips: () => zips,
  };
  return state;
}

function fakeNotifier() {
  const reports: string[] = [];
  let cleared = 0;
  return {
    notifier: {
      report: (message: string) => {
        reports.push(message);
      },
      clear: () => {
        cleared += 1;
      },
    },
    reports,
    cleared: () => cleared,
  };
}

let clock: ReturnType<typeof fakeClock>;
let writer: ReturnType<typeof fakeWriter>;
let source: ReturnType<typeof fakeSource>;
let notifier: ReturnType<typeof fakeNotifier>;

function session(over: Record<string, unknown> = {}): AutosaveSession {
  return new AutosaveSession({
    clock: clock.clock,
    writer: writer.writer,
    source: source.source,
    notifier: notifier.notifier,
    ...over,
  } as any);
}

beforeEach(() => {
  clock = fakeClock();
  writer = fakeWriter();
  source = fakeSource();
  notifier = fakeNotifier();
});

describe("the idle timer", () => {
  it("arms one idle timer and one ceiling on the first change", () => {
    const s = session();
    s.noteChange();
    expect(clock.delays()).toEqual([AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_WAIT_MS]);
    expect(s.currentState).toBe("armed");
    expect(writer.calls).toHaveLength(0);
  });

  it("does not write before the idle time is up", () => {
    const s = session();
    s.noteChange();
    clock.advance(AUTOSAVE_IDLE_MS - 100);
    expect(writer.calls).toHaveLength(0);
  });

  it("writes when the idle timer fires", async () => {
    const s = session();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
    expect(writer.calls[0].key).toBe("f-abc-Film");
    expect(writer.calls[0].meta).toEqual({
      label: "Film.ngt",
      anchor: "/Users/me/Film.ngt",
    });
  });

  it("re-arms the idle timer on every change", () => {
    const s = session();
    s.noteChange();
    const first = clock.pending().find((p) => p.ms === AUTOSAVE_IDLE_MS)!.id;
    s.noteChange();
    const second = clock.pending().find((p) => p.ms === AUTOSAVE_IDLE_MS)!.id;
    expect(second).not.toBe(first);
    // Still exactly one idle timer and one ceiling.
    expect(clock.delays()).toEqual([AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_WAIT_MS]);
  });

  it("collapses a burst of changes into one write", async () => {
    const s = session();
    for (let i = 0; i < 50; i++) {
      s.noteChange();
    }
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });
});

describe("the ceiling", () => {
  it("is armed only on the idle → armed transition", () => {
    // LOAD-BEARING. Re-arming the ceiling on a later change turns "at most 60
    // seconds at risk" into "unbounded", because a user dragging continuously
    // re-arms the idle timer forever.
    const s = session();
    s.noteChange();
    const ceiling = clock.pending().find((p) => p.ms === AUTOSAVE_MAX_WAIT_MS)!.id;

    for (let i = 0; i < 20; i++) {
      s.noteChange();
    }

    const stillArmed = clock
      .pending()
      .find((p) => p.ms === AUTOSAVE_MAX_WAIT_MS);
    expect(stillArmed?.id).toBe(ceiling);
  });

  it("writes exactly twice when edits never stop for 120 seconds", async () => {
    // LOAD-BEARING, and the single most important case in the file. Without
    // the ceiling this number is 0 and the whole feature has failed silently.
    const s = session();

    let written = 0;
    for (let second = 0; second < 120; second++) {
      s.noteChange();
      source.setDigest(`d${second}`);

      // A change every second: the 5s idle timer is re-armed before it can
      // fire, so only the ceiling can produce a write.
      clock.advance(1_000);
      const ceiling = clock.pending().find((p) => p.ms === AUTOSAVE_MAX_WAIT_MS);
      if (ceiling != null && (second + 1) % 60 === 0) {
        clock.fire(AUTOSAVE_MAX_WAIT_MS);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        written = writer.calls.length;
      }
    }

    expect(written).toBe(2);
    expect(writer.calls).toHaveLength(2);
  });

  it("arms a fresh ceiling after a write", async () => {
    const s = session();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();

    // Settled idle, so the next change starts a new window.
    expect(s.currentState).toBe("idle");
    source.setDigest("d2");
    s.noteChange();
    expect(clock.delays()).toEqual([AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_WAIT_MS]);
  });
});

describe("declining to write", () => {
  it("writes nothing when the digest matches the baseline", async () => {
    const s = session();
    source.setDigest("saved");
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();

    expect(writer.calls).toHaveLength(0);
    expect(writer.drops).toHaveLength(0);
    expect(s.currentState).toBe("idle");
  });

  it("assembles no archive when it declines", async () => {
    // The digest comparison happens first, so an unchanged project costs no
    // zip at all — which is what makes a five-second cadence affordable.
    const s = session();
    source.setDigest("saved");
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(source.zips()).toBe(0);
  });

  it("writes nothing for the same bytes twice", async () => {
    const s = session();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);

    // Same digest again — an edit and its inverse, say.
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });

  it("leaves the ring alone when an undo returns to the saved state", async () => {
    // The invariant survives in the direction that matters — "the menu is
    // empty" never under-reports unsaved work — and deleting files on an undo
    // keystroke is not something to do.
    const s = session();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();

    source.setDigest("saved");
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();

    expect(writer.drops).toHaveLength(0);
  });

  it("writes when the baseline is unknown", async () => {
    // A session with no baseline yet is conservatively dirty.
    const s = session();
    source.setBaseline(null);
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });
});

describe("an unreadable document", () => {
  it("defers rather than throwing", async () => {
    const s = session();
    source.hide();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();

    expect(writer.calls).toHaveLength(0);
    expect(s.currentState).toBe("armed");
    expect(clock.delays()).toContain(AUTOSAVE_IDLE_MS);
  });

  it("writes the change once the document can be read", async () => {
    // LOAD-BEARING-adjacent: the change must survive the deferral.
    const s = session();
    source.hide();
    s.noteChange();

    for (let i = 0; i < 3; i++) {
      clock.fire(AUTOSAVE_IDLE_MS);
      await Promise.resolve();
    }
    expect(writer.calls).toHaveLength(0);

    source.show();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });
});

describe("one write at a time", () => {
  it("makes one write call when two timers fire during a write", async () => {
    const s = session();
    writer.holdNext();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(s.currentState).toBe("writing");

    // Both of these arrive while the write is in flight.
    await s.flush();
    await s.flush();
    expect(writer.calls).toHaveLength(1);

    writer.release();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("writes again for a change that arrived mid-write", async () => {
    // LOAD-BEARING. Drop this and the last edit before a pause is never
    // written: the write in flight is of an older state, and nothing else
    // would re-arm.
    const s = session();
    writer.holdNext();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(s.currentState).toBe("writing");

    source.setDigest("d-newer");
    s.noteChange();

    writer.release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Re-armed, with both timers fresh.
    expect(s.currentState).toBe("armed");
    expect(clock.delays()).toEqual([AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_WAIT_MS]);

    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(2);
    expect(s.attemptedWrites).toBe(2);
  });

  it("settles idle when nothing changed during the write", async () => {
    const s = session();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.currentState).toBe("idle");
    expect(clock.delays()).toEqual([]);
  });
});

describe("failure", () => {
  it("stays armed and retries when the write rejects", async () => {
    // LOAD-BEARING. Treating a thrown write as done is total silent loss.
    const s = session();
    writer.failHard();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(s.currentState).toBe("armed");
    expect(s.consecutiveFailures).toBe(1);

    writer.succeed();
    clock.fire(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(2);
    expect(s.consecutiveFailures).toBe(0);
  });

  it("stays armed and retries when the write answers ok: false", async () => {
    // LOAD-BEARING, and a separate path from a rejection — this is the one
    // `writeFileEnsured` reports and the one a full disk produces.
    const s = session();
    writer.failSoft();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(s.currentState).toBe("armed");
    expect(s.consecutiveFailures).toBe(1);

    writer.succeed();
    clock.fire(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(2);
  });

  it("retries the same state rather than assuming it was written", async () => {
    // LOAD-BEARING. If a failed write recorded its digest as written, the
    // retry would decline as a duplicate and the state would never land.
    const s = session();
    writer.failSoft();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();

    writer.succeed();
    clock.fire(5_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(writer.calls).toHaveLength(2);
    // The same digest both times.
    expect(writer.calls[0].bytes).toEqual(writer.calls[1].bytes);
  });

  it("backs off 5, 15, 45 then 60 seconds", async () => {
    const s = session();
    writer.failSoft();

    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();

    for (const expected of [5_000, 15_000, 45_000, 60_000, 60_000]) {
      // The ceiling is armed alongside the retry, because the session is
      // `armed` — see `ensureCeiling`. The retry delay is the interesting one.
      expect(clock.delays()).toContain(expected);
      clock.fire(expected);
      await Promise.resolve();
      await Promise.resolve();
    }
  });

  it("tells the user after three consecutive failures, not before", async () => {
    const s = session();
    writer.failSoft("ENOSPC");

    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.reports).toHaveLength(0);

    clock.fire(5_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.reports).toHaveLength(0);

    clock.fire(15_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.reports).toHaveLength(1);
    expect(notifier.reports[0]).toContain("ENOSPC");
  });

  it("clears the report on the next success", async () => {
    const s = session();
    writer.failSoft();
    s.noteChange();
    for (const ms of [AUTOSAVE_IDLE_MS, 5_000, 15_000]) {
      clock.fire(ms);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(notifier.reports).toHaveLength(1);

    writer.succeed();
    clock.fire(45_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifier.cleared()).toBeGreaterThan(0);
  });
});

describe("during an export", () => {
  function withExport(busy: () => boolean) {
    return session({ exportGate: { isBusy: busy } });
  }

  it("defers while the export runs", async () => {
    let busy = true;
    const s = withExport(() => busy);
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();

    expect(writer.calls).toHaveLength(0);
    expect(clock.delays()).toContain(AUTOSAVE_EXPORT_POLL_MS);
  });

  it("writes once the export finishes", async () => {
    let busy = true;
    const s = withExport(() => busy);
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();

    busy = false;
    clock.fire(AUTOSAVE_EXPORT_POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });

  it("writes anyway once the override elapses", async () => {
    // Deferring forever is the "never writes" failure in another costume, and
    // editing during a render is explicitly allowed.
    const s = withExport(() => true);
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(writer.calls).toHaveLength(0);

    clock.advance(AUTOSAVE_EXPORT_OVERRIDE_MS + 1);
    clock.fire(AUTOSAVE_EXPORT_POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });

  it("does not defer when no gate is supplied", async () => {
    const s = session();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });
});

describe("the ceiling survives a deferral", () => {
  // LOAD-BEARING, both routes. A deferral clears the timers and returns to
  // `armed`; without re-arming the ceiling there, a user who keeps editing
  // while the document is unreadable, or while an export runs, re-arms the
  // idle timer forever against no ceiling and is never written at all. That
  // is the same unbounded failure the ceiling exists to prevent, reached by a
  // second route — and it survived the first draft of this module.

  it("keeps a ceiling armed after an unreadable snapshot", async () => {
    const s = session();
    source.hide();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(clock.delays()).toContain(AUTOSAVE_MAX_WAIT_MS);
  });

  it("writes despite continuous editing while the document was unreadable", async () => {
    const s = session();
    source.hide();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();

    // The document comes back, and the user never stops editing — so the idle
    // timer is re-armed every second and only the ceiling can fire.
    source.show();
    for (let i = 0; i < 30; i++) {
      s.noteChange();
      clock.advance(1_000);
    }
    expect(writer.calls).toHaveLength(0);

    clock.fire(AUTOSAVE_MAX_WAIT_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });

  it("keeps a ceiling armed while an export defers it", async () => {
    const s = session({ exportGate: { isBusy: () => true } });
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(clock.delays()).toContain(AUTOSAVE_MAX_WAIT_MS);
  });

  it("keeps a ceiling armed after a failed write", async () => {
    const s = session();
    writer.failSoft();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.delays()).toContain(AUTOSAVE_MAX_WAIT_MS);
  });

  it("arms exactly one ceiling however many changes arrive", () => {
    // Idempotent, and it must be: a change while armed must not push the
    // ceiling out, or the guarantee is worthless.
    const s = session();
    for (let i = 0; i < 100; i++) {
      s.noteChange();
    }
    expect(
      clock.delays().filter((ms) => ms === AUTOSAVE_MAX_WAIT_MS),
    ).toHaveLength(1);
  });
});

describe("markSaved", () => {
  it("drops the rings it is given", async () => {
    const s = session();
    await s.markSaved(["s-session", "f-abc-Film"]);
    expect(writer.drops).toEqual([["s-session", "f-abc-Film"]]);
  });

  it("drops two identities for a Save As", async () => {
    // Untitled → Film.ngt retires the session's ring *and* any ring already
    // at Film.ngt from an earlier crash: the user has just written that path.
    const s = session();
    await s.markSaved(["s-old", "f-new-Film"]);
    expect(writer.drops[0]).toHaveLength(2);
  });

  it("cancels a pending write", async () => {
    const s = session();
    s.noteChange();
    expect(clock.delays()).not.toEqual([]);
    await s.markSaved(["f-abc-Film"]);
    expect(clock.delays()).toEqual([]);
    expect(s.currentState).toBe("idle");
  });

  it("writes again for a change after the save", async () => {
    const s = session();
    await s.markSaved(["f-abc-Film"]);

    source.setDigest("after-save");
    source.setBaseline("saved");
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });

  it("writes the same state again after a save dropped the ring", async () => {
    // The ring is gone, so nothing in it can be "already written". Without
    // clearing `lastWritten`, a project saved and then edited back to the
    // state it had before the save would decline as a duplicate and have no
    // recovery point at all.
    const s = session();
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);

    await s.markSaved(["f-abc-Film"]);

    // Same digest as the entry that was just deleted.
    source.setBaseline("something-else");
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(2);
  });
});

describe("markRecovered", () => {
  it("does not drop the ring it came from", async () => {
    // LOAD-BEARING, and the worst failure this feature could have: a user who
    // picked 14:22 when they meant 14:25 would have destroyed the right entry
    // by looking at the wrong one. Recovery is read-only on the cache.
    const s = session();
    s.markRecovered("recovered");
    expect(writer.drops).toEqual([]);
  });

  it("writes no byte-identical duplicate of what it recovered", async () => {
    const s = session();
    s.markRecovered("recovered");

    source.setDigest("recovered");
    source.setBaseline(null);
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    expect(writer.calls).toHaveLength(0);
  });

  it("writes the first real edit after a recovery", async () => {
    const s = session();
    s.markRecovered("recovered");

    source.setDigest("edited-after-recovery");
    source.setBaseline(null);
    s.noteChange();
    clock.fire(AUTOSAVE_IDLE_MS);
    await Promise.resolve();
    await Promise.resolve();
    expect(writer.calls).toHaveLength(1);
  });

  it("cancels a pending write", () => {
    const s = session();
    s.noteChange();
    s.markRecovered("recovered");
    expect(clock.delays()).toEqual([]);
  });
});

describe("stop", () => {
  it("clears every timer", () => {
    const s = session();
    s.noteChange();
    expect(clock.delays()).toHaveLength(2);
    s.stop();
    expect(clock.delays()).toEqual([]);
    expect(s.currentState).toBe("idle");
  });

  it("is safe to call twice", () => {
    const s = session();
    s.stop();
    s.stop();
    expect(clock.delays()).toEqual([]);
  });
});
