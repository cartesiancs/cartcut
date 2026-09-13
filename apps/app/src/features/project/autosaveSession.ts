/**
 * When Auto Save writes, and what it does when it cannot.
 *
 * ```
 * idle ──change──▶ armed ──idle 5s | ceiling 60s──▶ writing ──▶ idle
 *                    ▲                                 │
 *                    └──── dirty during the write ──────┘
 * ```
 *
 * Every dependency is an injected port declared as a plain record — the
 * `caption/previewLoop.ts` and `caption/transcribeSession.ts` convention, and
 * deliberately *not* `option/gestureCommit.ts`'s reach for `window.*`, which
 * is what forces its suite to install a fake `window` and run fake timers.
 * Nothing here touches the DOM, a store, or IPC, so the whole state machine
 * runs under `environment: "node"` against fakes that let the test decide when
 * a timer fires.
 *
 * ## The two timers are not the same timer
 *
 * The **idle** timer is re-armed by every change, so a burst of edits costs one
 * write once the burst stops. The **ceiling** is armed only on the
 * `idle → armed` transition and is *never* re-armed by a later change — which
 * is the entire point of a max-wait. Re-arming it turns "at most 60 seconds of
 * work at risk" into "unbounded, silently", because a user dragging
 * continuously for ten minutes re-arms the idle timer forever and would never
 * be written at all.
 *
 * ## Failure never clears dirt
 *
 * A write that rejects, or answers `{ ok: false }`, leaves the session armed
 * and backs off. The opposite — treating a failed write as done — is the exact
 * shape of the defect `writeFileEnsured` was written to fix, one layer up, and
 * here it would delete the user's only unsaved copy on the next save.
 *
 * After three consecutive failures it raises a row in `backgroundTaskStore`
 * through the `Notifier` port. Not a toast: a toast every five seconds on a
 * full disk is worse than the failure it reports.
 */

import type { AutosaveKey } from "./autosaveIdentity";

/** Quiet time after the last change before a write. */
export const AUTOSAVE_IDLE_MS = 5_000;

/** The longest a change can go unwritten while editing continues. */
export const AUTOSAVE_MAX_WAIT_MS = 60_000;

/** How often to look again while an export is running. */
export const AUTOSAVE_EXPORT_POLL_MS = 15_000;

/** After this long deferred behind an export, write anyway. */
export const AUTOSAVE_EXPORT_OVERRIDE_MS = 600_000;

/** Re-arm delays after consecutive failures. The last one repeats. */
export const AUTOSAVE_BACKOFF_MS: readonly number[] = [
  5_000, 15_000, 45_000, 60_000,
];

/** Consecutive failures before the user is told. */
export const AUTOSAVE_FAILURES_BEFORE_REPORT = 3;

/**
 * Everything a write needs, read at one instant.
 *
 * `bytes` is a thunk so the archive is only assembled once the session has
 * decided to write — the digest comparison happens first, and a project that
 * has not changed costs no zip at all.
 */
export type AutosaveSnapshot = {
  /** The digest of the project as it stands. */
  digest: string;
  /** The digest of what is on disk, or `null` if that is unknown. */
  baseline: string | null;
  key: AutosaveKey;
  /** What the menu calls this ring. */
  label: string;
  /** The `.ngt` this stands in for, or `null`. Path arithmetic, not identity. */
  anchor: string | null;
  bytes: () => Promise<Uint8Array>;
};

export type AutosaveWriteResult =
  | { ok: true; file: string; writtenAtMs: number }
  | { ok: false; error: string };

export type AutosaveClock = {
  now(): number;
  setTimer(ms: number, fn: () => void): number;
  clearTimer(id: number): void;
};

export type AutosaveWriter = {
  write(request: {
    key: AutosaveKey;
    bytes: Uint8Array;
    meta: { label: string; anchor: string | null };
  }): Promise<AutosaveWriteResult>;
  dropRings(keys: AutosaveKey[]): Promise<unknown>;
};

/**
 * The document, or `null` when it cannot be read.
 *
 * `null` **defers**; it is never an error. The real adapter reads
 * `element-control.previewRatio` off a Lit component, and an autosave firing
 * before that has mounted must not throw or lose the change.
 */
export type DocumentSource = { snapshot(): AutosaveSnapshot | null };

/** Whether an export is running. Writing during one steals its thread. */
export type ExportGate = { isBusy(): boolean };

/** How a persistent failure reaches the user. */
export type Notifier = {
  report(message: string): void;
  clear(): void;
};

export type AutosaveState = "idle" | "armed" | "writing";

export type AutosaveSessionPorts = {
  clock: AutosaveClock;
  writer: AutosaveWriter;
  source: DocumentSource;
  exportGate?: ExportGate;
  notifier?: Notifier;
  /** Overridable for the suite; production takes the defaults. */
  idleMs?: number;
  maxWaitMs?: number;
};

export class AutosaveSession {
  private state: AutosaveState = "idle";
  private idleTimer: number | null = null;
  private ceilingTimer: number | null = null;

  /** A change arrived while a write was in flight. */
  private dirtyDuringWrite = false;

  /** When the current run of export deferrals began. */
  private deferredSince: number | null = null;

  /** The digest of the last entry actually written. */
  private lastWritten: string | null = null;

  private failures = 0;

  /** Counters, for assertions. */
  private writes = 0;

  private readonly idleMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly ports: AutosaveSessionPorts) {
    this.idleMs = ports.idleMs ?? AUTOSAVE_IDLE_MS;
    this.maxWaitMs = ports.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
  }

  /** For assertions. */
  get currentState(): AutosaveState {
    return this.state;
  }

  /** For assertions: how many writes have been attempted. */
  get attemptedWrites(): number {
    return this.writes;
  }

  /** For assertions. */
  get consecutiveFailures(): number {
    return this.failures;
  }

  /**
   * The document changed.
   *
   * Cheap and synchronous — it is called from a store subscription, so it must
   * not serialize anything. The digest is only computed when a timer fires.
   */
  noteChange(): void {
    if (this.state === "writing") {
      // The write in flight is of an older state. Re-arming happens when it
      // settles, so the edit cannot be swallowed.
      this.dirtyDuringWrite = true;
      return;
    }

    if (this.state === "idle") {
      this.deferredSince = null;
    }
    this.state = "armed";

    this.rearmIdle(this.idleMs);
    this.ensureCeiling();
  }

  /**
   * Guarantee the invariant **armed implies a ceiling is pending**.
   *
   * Idempotent, and that is the whole design: a change while already armed
   * must *not* push the ceiling out, so this only arms one when none is
   * pending. Calling it on every change is what keeps the guarantee true
   * without giving a later change the power to extend the window.
   *
   * It is called from the deferral paths in `flush` as well, which is less
   * obvious and was a real hole: both of those clear the timers and go back
   * to `armed`, so without re-arming here a user who kept editing while the
   * document was unreadable — or while an export ran — would re-arm the idle
   * timer forever against no ceiling at all, and never be written. The same
   * unbounded failure the ceiling exists to prevent, by a second route.
   */
  private ensureCeiling(): void {
    if (this.ceilingTimer != null) {
      return;
    }
    this.ceilingTimer = this.ports.clock.setTimer(this.maxWaitMs, () => {
      this.ceilingTimer = null;
      void this.flush();
    });
  }

  private rearmIdle(ms: number): void {
    if (this.idleTimer != null) {
      this.ports.clock.clearTimer(this.idleTimer);
    }
    this.idleTimer = this.ports.clock.setTimer(ms, () => {
      this.idleTimer = null;
      void this.flush();
    });
  }

  private clearTimers(): void {
    if (this.idleTimer != null) {
      this.ports.clock.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.ceilingTimer != null) {
      this.ports.clock.clearTimer(this.ceilingTimer);
      this.ceilingTimer = null;
    }
  }

  /**
   * Write now if there is anything to write.
   *
   * Single-flight by state rather than by a flag the caller sets: two timers
   * firing during one write produce one `write` call.
   */
  async flush(): Promise<void> {
    if (this.state === "writing") {
      this.dirtyDuringWrite = true;
      return;
    }

    this.clearTimers();

    const snapshot = this.ports.source.snapshot();
    if (snapshot == null) {
      // Not an error — the component it reads has not mounted. Keep the
      // change and look again; the ceiling's expiry is remembered so the next
      // readable snapshot writes at once rather than waiting another minute.
      this.state = "armed";
      this.rearmIdle(this.idleMs);
      this.ensureCeiling();
      return;
    }

    if (this.deferExport()) {
      this.state = "armed";
      this.rearmIdle(AUTOSAVE_EXPORT_POLL_MS);
      this.ensureCeiling();
      return;
    }

    // Nothing has diverged from what is on disk. The ring is left alone: an
    // undo back to the saved state skips the write but does not delete the
    // recovery points already in the ring, which are real past states.
    if (snapshot.baseline != null && snapshot.digest === snapshot.baseline) {
      this.settleIdle();
      return;
    }

    // These exact bytes are already the newest entry.
    if (snapshot.digest === this.lastWritten) {
      this.settleIdle();
      return;
    }

    this.state = "writing";
    this.dirtyDuringWrite = false;
    this.writes += 1;

    let result: AutosaveWriteResult;
    try {
      result = await this.ports.writer.write({
        key: snapshot.key,
        bytes: await snapshot.bytes(),
        meta: { label: snapshot.label, anchor: snapshot.anchor },
      });
    } catch (error) {
      result = { ok: false, error: String(error) };
    }

    if (result.ok) {
      this.lastWritten = snapshot.digest;
      this.failures = 0;
      this.ports.notifier?.clear();
      // A fresh ceiling as well as a fresh idle timer: the write just
      // happened, so "you have not been written in 60 seconds" is newly true.
      if (this.dirtyDuringWrite) {
        this.state = "idle";
        this.noteChange();
      } else {
        this.settleIdle();
      }
      return;
    }

    // **Dirt is never cleared here.** `lastWritten` is untouched, so the same
    // state is retried rather than assumed written.
    this.failures += 1;
    if (this.failures >= AUTOSAVE_FAILURES_BEFORE_REPORT) {
      this.ports.notifier?.report(
        `Auto Save could not write a recovery copy (${result.error}).`,
      );
    }

    this.state = "armed";
    this.rearmIdle(this.backoff());
    this.ensureCeiling();
  }

  private backoff(): number {
    // `failures - 1`: the count has already been incremented, and the *first*
    // retry is the table's first entry. Off by one here makes the first retry
    // wait 15 seconds instead of 5, which is invisible except as a slightly
    // wider window of lost work.
    const index = Math.min(
      Math.max(this.failures - 1, 0),
      AUTOSAVE_BACKOFF_MS.length - 1,
    );
    return AUTOSAVE_BACKOFF_MS[index];
  }

  private settleIdle(): void {
    this.state = "idle";
    this.dirtyDuringWrite = false;
    this.deferredSince = null;
  }

  /**
   * Whether to stand aside for a running export.
   *
   * Deferred rather than skipped, with a hard override: the export frame loop
   * is on this thread pushing megabytes a frame into a pipe, but editing
   * during a render is explicitly allowed, so changes *will* arrive and
   * deferring forever is the "never writes" failure in another costume.
   */
  private deferExport(): boolean {
    if (this.ports.exportGate?.isBusy() !== true) {
      this.deferredSince = null;
      return false;
    }

    const now = this.ports.clock.now();
    if (this.deferredSince == null) {
      this.deferredSince = now;
      return true;
    }
    return now - this.deferredSince < AUTOSAVE_EXPORT_OVERRIDE_MS;
  }

  /**
   * The project was saved to `keys`' identities. Retire their rings.
   *
   * Several keys because one save can retire two identities: saving an
   * untitled project as `Film.ngt` supersedes the session's own ring *and* any
   * ring already at `Film.ngt` from an earlier crash. The user has just
   * written that exact path, so anything there is older than the file.
   */
  async markSaved(keys: AutosaveKey[]): Promise<void> {
    // The ring is gone, so nothing in it can be "already written".
    this.lastWritten = null;
    this.clearTimers();
    this.settleIdle();
    await this.ports.writer.dropRings(keys);
  }

  /**
   * A recovery landed. Adopt its bytes as the newest thing written.
   *
   * The recovered state *is* in the ring, so re-writing it immediately would
   * add a byte-identical duplicate. It does **not** drop the ring it came
   * from: the other entries are still the only copies of those states, and a
   * user who picked 14:22 when they meant 14:25 must not have destroyed the
   * right one by looking at the wrong one.
   */
  markRecovered(digest: string): void {
    this.lastWritten = digest;
    this.clearTimers();
    this.settleIdle();
  }

  /** Drop every timer. For teardown, and for the suite. */
  stop(): void {
    this.clearTimers();
    this.state = "idle";
  }
}
