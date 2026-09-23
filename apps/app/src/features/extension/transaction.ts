/**
 * Many edits, one undo step.
 *
 * `commands/plan.ts` already states why this matters and says it better than a
 * second copy would: an agent whose work takes sixty undos to reject may as
 * well not have undo. `apply_edit_plan` solves it for one fixed shape of edit;
 * this generalises it to any list of commands an extension wants to run
 * together.
 *
 * ## Why a collector rather than pure ops
 *
 * The alternative was to split every one of the fifty-odd agent commands into
 * a "compute the op" half and an "apply it" half, and compose the halves. That
 * fails on the rule `commit.ts` opens with: the probe must run before the
 * baseline, and re-stating that in fifty places is fifty chances to get it
 * wrong. So instead `commit` stays the single implementation and learns to
 * write into a working document when one is open, and `currentDoc` returns
 * that working document so step N sees step N-1's result.
 *
 * ## Synchronous, and that is the safety property
 *
 * A batch runs every step in one tick and closes before it returns. Nothing
 * else in the renderer can call `commit` in the middle of it: not the user's
 * pointer, not an MCP tool call, not another extension. An `await` inside the
 * collector would open exactly that window, and an edit that landed in it
 * would be silently absorbed into somebody else's undo step. So an
 * asynchronous command is refused rather than awaited, and the refusal names
 * the command.
 */

import { normalizeDocument, type TimelineDocument } from "../timeline/tracks";

export type BatchStep = { name: string; params?: unknown };

export type BatchOutcome = {
  ok: boolean;
  reason?: string;
  created: string[];
  removed: string[];
  changed: string[];
  /** One entry per step, in order, so a caller can see which declined. */
  steps: Array<{ name: string; ok: boolean; reason?: string }>;
};

export type Transaction = {
  before: TimelineDocument;
  working: TimelineDocument;
};

export type BatchPorts = {
  getDocument(): TimelineDocument;
  withCheckpoint(fn: (doc: TimelineDocument) => TimelineDocument): void;
  ensureUndoBaseline(): void;
  isLocked(): boolean;
  lockMessage(): string;
  runCommand(name: string, params: unknown): unknown;
};

/**
 * Commands that may not appear in a batch.
 *
 * Two kinds. The asynchronous ones cannot be, for the reason in the header:
 * they would have to be awaited and the collector would be open while
 * anything else could edit. The rest could be, and are refused because they
 * mean nothing inside one undo step: `undo` inside a transaction that has not
 * been committed has nothing to undo, and `apply_edit_plan` is already exactly
 * this mechanism with a fixed shape.
 */
export const NON_TRANSACTIONAL = new Set([
  "undo",
  "redo",
  "apply_edit_plan",
  "set_playhead",
  "select_clips",
  "add_media",
  "rasterize_text",
  "render_contact_sheet",
  "get_transcript_source",
  "map_transcript",
  "map_analysis",
]);

let active: Transaction | null = null;

/** The open transaction, or null. Read by `commit` and `currentDoc`. */
export function activeTransaction(): Transaction | null {
  return active;
}

/**
 * Fold a pure op into the working document.
 *
 * Called by `commit` when a transaction is open, so that every command's
 * decline rule and every command's ordering still apply, unchanged, from
 * inside a batch.
 */
export function applyInTransaction(
  transaction: Transaction,
  fn: (doc: TimelineDocument) => TimelineDocument,
): { changed: boolean; before: TimelineDocument; after: TimelineDocument } {
  const before = transaction.working;
  const after = fn(before);
  if (after === before) {
    return { changed: false, before, after: before };
  }
  // `normalizeDocument` is what `withCheckpoint` would have run, so a step
  // that reads the working document sees a document in the same shape it
  // would see outside a batch: track names filled in, priorities derived,
  // hierarchy repaired.
  transaction.working = normalizeDocument(after);
  return { changed: true, before, after: transaction.working };
}

function diff(before: TimelineDocument, after: TimelineDocument) {
  const created: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of Object.keys(after.elements)) {
    if (before.elements[id] == null) {
      created.push(id);
    } else if (before.elements[id] !== after.elements[id]) {
      changed.push(id);
    }
  }
  for (const id of Object.keys(before.elements)) {
    if (after.elements[id] == null) {
      removed.push(id);
    }
  }
  return { created, removed, changed };
}

function failure(reason: string, steps: BatchOutcome["steps"] = []): BatchOutcome {
  return { ok: false, reason, created: [], removed: [], changed: [], steps };
}

/**
 * Run every step, then record one checkpoint.
 *
 * Nothing reaches the store until the last step has run, so a batch that
 * throws half way leaves the timeline exactly as it was. That is the other
 * half of what makes this worth having: an extension's bug costs the user
 * nothing rather than costing them a half-applied edit they have to unpick.
 */
export function runBatch(steps: readonly BatchStep[], ports: BatchPorts): BatchOutcome {
  if (active != null) {
    return failure("a batch is already running: batches cannot be nested");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    return failure("a batch needs at least one step");
  }
  if (ports.isLocked()) {
    return failure(ports.lockMessage());
  }

  for (const step of steps) {
    if (typeof step?.name !== "string" || step.name === "") {
      return failure("every step needs a command name");
    }
    if (NON_TRANSACTIONAL.has(step.name)) {
      return failure("`" + step.name + "` cannot run inside a batch");
    }
  }

  const before = ports.getDocument();
  const transaction: Transaction = { before, working: before };
  active = transaction;

  const results: BatchOutcome["steps"] = [];
  try {
    for (const step of steps) {
      const result = ports.runCommand(step.name, step.params ?? {});
      if (result != null && typeof (result as { then?: unknown }).then === "function") {
        // Refused rather than awaited. Awaiting would leave the collector open
        // across a tick, and an edit that landed in that window would be
        // absorbed into this batch's undo step without anyone asking.
        return failure("`" + step.name + "` is asynchronous and cannot run inside a batch", results);
      }
      const outcome = (result ?? {}) as { ok?: boolean; reason?: string };
      results.push({ name: step.name, ok: outcome.ok === true, reason: outcome.reason });
    }
  } catch (error) {
    return failure(
      "`" + (error instanceof Error ? error.message : String(error)) + "` stopped the batch, so nothing was applied",
      results,
    );
  } finally {
    active = null;
  }

  if (transaction.working === before) {
    // Every step declined. No checkpoint, exactly as a single declining
    // command records none: a batch that changed nothing must cost the user
    // nothing.
    return {
      ok: false,
      reason: "no step in the batch changed anything",
      created: [],
      removed: [],
      changed: [],
      steps: results,
    };
  }

  // Asserted rather than assumed. The batch is synchronous, so nothing should
  // have been able to edit while it ran; if something did, its work is in the
  // store and `withCheckpoint` would overwrite it.
  //
  // Compared on `elements` and `tracks`, not on the document: `getDocument`
  // builds a fresh wrapper on every call, so comparing the wrappers would
  // report a change every time and no batch would ever apply.
  const now = ports.getDocument();
  if (now.elements !== before.elements || now.tracks !== before.tracks) {
    return failure("the timeline changed while the batch was running, so nothing was applied", results);
  }

  ports.ensureUndoBaseline();
  const finished = transaction.working;
  ports.withCheckpoint(() => finished);

  return { ok: true, ...diff(before, finished), steps: results };
}

/** Test-only: drop an open transaction so one failure cannot poison the next test. */
export function __resetTransactionForTesting(): void {
  active = null;
}
