/**
 * Recovering an Auto Save. The only way back into the cache.
 *
 * Reached from File → Auto Save and from nowhere else — no button, no
 * keystroke, no automatic offer on launch. A recovery replaces everything on
 * the timeline, so it has to be something the user asked for in as many words.
 *
 * ## The guard: non-empty **or** dirty
 *
 * Stricter than File → Open's, and deliberately so. Open refuses on *dirty*
 * only, because a clean project is on disk and opening another loses nothing —
 * refusing there on non-empty would mean never being able to open a second
 * project. A recovery has no such out: it overwrites whatever is loaded, saved
 * or not, so a non-empty timeline is reason enough to refuse.
 *
 * `tracks.length` counts on its own. Three added rows and nothing else is work
 * worth refusing over, and it is exactly what the detector this replaced read
 * as unmodified.
 *
 * ## The session comes back detached
 *
 * `#projectFile` is left **empty**, so ⌘S opens Save As and the original
 * `.ngt` is never touched by a recovery. The archive's anchor is read — it has
 * to be, or the relative asset paths resolve against `userData/autosave` and
 * every clip reports as missing media — but it is used for that and nothing
 * else. Adopting it as the project's path is what would make the next ⌘S
 * overwrite the user's file with a recovered older state, so the path port
 * exists here and is never called, and the suite asserts that.
 *
 * ## The ring is not touched
 *
 * Reading one entry leaves the other nine alone. They are still the only
 * copies of those states, and a user who picked 14:22 when they meant 14:25
 * must not have destroyed the right one by looking at the wrong one.
 */

import type { ExistsFn } from "./assetsFile";
import { openNgt, readNgtEntries, readNgtExtra } from "./projectArchive";
import {
  readProjectDocument,
  readProjectFailureMessage,
  type ReadProjectResult,
} from "./projectDocument";
import { uiStore } from "../../states/uiStore";
import { autosaveSession } from "./autosaveBridge";
import {
  currentProjectDigest,
  isProjectDirty,
  isProjectEmpty,
} from "./projectDirty";

/** What the menu sends with `file.autoSaveRecover`. */
export type AutosavePick = { key: string; file: string };

/**
 * The sixth zip entry an autosave carries.
 *
 * Read defensively rather than trusted: a hand-copied archive may not have it
 * at all, and `SCHEMA_VERSION` deliberately did not move for it, so an older
 * build's `.ngt` has none either.
 */
type AutosaveArchiveMeta = {
  anchor?: unknown;
  writtenAtMs?: unknown;
} | null;

export type RecoverOutcome =
  | { kind: "recovered"; from: string; missing: number }
  | { kind: "refused"; reason: "not-empty" | "dirty"; message: string }
  | { kind: "failed"; message: string };

/** The state the guard reads. */
export type RecoverGuardPort = {
  isEmpty(): boolean;
  isDirty(): boolean;
};

/** Reading the archive. */
export type RecoverReaderPort = {
  readFile(path: string): Promise<unknown>;
  exists: ExistsFn;
};

/**
 * Everything the recovery performs.
 *
 * `setProjectPath` is declared and **never called** — see the header. It is
 * here so "the recovered session adopts no path" is a node assertion rather
 * than an e2e hope.
 */
export type RecoverEffectsPort = {
  adopt(read: Extract<ReadProjectResult, { ok: true }>): void;
  setTitle(title: string): void;
  setProjectPath(path: string): void;
  warn(message: string): void;
  toast(message: string): void;
  markRecovered(): void;
};

export const RECOVER_NOT_EMPTY_MESSAGE =
  "There is already an edit open. Auto Save recovery replaces everything on " +
  "the timeline, so it only runs on an empty project — save or close this " +
  "one first.";

export const RECOVER_DIRTY_MESSAGE =
  "This project has unsaved changes. Auto Save recovery replaces everything " +
  "on the timeline, so save this project first.";

function parse(raw: string | null): unknown {
  if (raw == null) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** A short clock time for the "recovered from" toast. */
function timeOf(atMs: number | null): string {
  if (atMs == null) {
    return "the auto-save";
  }
  return new Date(atMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Recover the entry at `pick.file`.
 *
 * Pure of the DOM and of IPC: everything it touches is a port, so the guard,
 * the anchor and the "no path adopted" rule are all node-testable.
 */
export async function recoverAutosave(
  pick: AutosavePick,
  guard: RecoverGuardPort,
  reader: RecoverReaderPort,
  effects: RecoverEffectsPort,
): Promise<RecoverOutcome> {
  // **Before any read.** A refusal must be free of side effects — it does not
  // touch the store, and it does not even open the file.
  if (!guard.isEmpty()) {
    effects.warn(RECOVER_NOT_EMPTY_MESSAGE);
    return {
      kind: "refused",
      reason: "not-empty",
      message: RECOVER_NOT_EMPTY_MESSAGE,
    };
  }
  if (guard.isDirty()) {
    effects.warn(RECOVER_DIRTY_MESSAGE);
    return { kind: "refused", reason: "dirty", message: RECOVER_DIRTY_MESSAGE };
  }

  let entries;
  let autosaveMeta: AutosaveArchiveMeta = null;
  try {
    const zip = await openNgt(await reader.readFile(pick.file));
    entries = await readNgtEntries(zip);
    const raw = parse(await readNgtExtra(zip, "autosave.json"));
    autosaveMeta =
      raw != null && typeof raw === "object" ? (raw as AutosaveArchiveMeta) : null;
  } catch (error) {
    const message = `That auto-save could not be read — ${String(error)}.`;
    effects.warn(message);
    return { kind: "failed", message };
  }

  // The anchor the archive recorded, or the archive itself. A hand-copied
  // autosave with no `autosave.json` still recovers, anchored on where it
  // sits, possibly reporting missing media — which is better than refusing.
  const anchor =
    typeof autosaveMeta?.anchor === "string" && autosaveMeta.anchor !== ""
      ? autosaveMeta.anchor
      : pick.file;

  const read = await readProjectDocument(entries, anchor, reader.exists);
  if (!read.ok) {
    const message = readProjectFailureMessage(read);
    effects.warn(message);
    return { kind: "failed", message };
  }

  effects.adopt(read);

  // `setProjectPath` is *not* called. The session is detached, so ⌘S opens
  // Save As and the original `.ngt` cannot be overwritten with older state.
  const name = typeof autosaveMeta?.anchor === "string" ? autosaveMeta.anchor : null;
  effects.setTitle(
    name == null
      ? `Cartcut - Recovered — unsaved`
      : `Cartcut - Recovered (${basename(name)}) — unsaved`,
  );

  effects.markRecovered();

  const writtenAt =
    typeof autosaveMeta?.writtenAtMs === "number"
      ? autosaveMeta.writtenAtMs
      : null;
  effects.toast(
    `Recovered the auto-save from ${timeOf(writtenAt)}. Save it with ⌘S.`,
  );

  if (read.missing > 0) {
    // Counted in files rather than clips, as the load path does: twenty cuts
    // of one missing video are one thing to go and find.
    effects.toast(
      read.missing === 1
        ? `1 media file could not be found.`
        : `${read.missing} media files could not be found.`,
    );
  }

  return { kind: "recovered", from: pick.file, missing: read.missing };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] !== "") {
      return parts[i];
    }
  }
  return path;
}

// ---------------------------------------------------------------------------
// The real ports. Everything below touches the DOM, the stores or IPC, and is
// the thin half the suite above does not reach.
// ---------------------------------------------------------------------------

/**
 * Recover the entry the menu named.
 *
 * The payload arrives as `unknown` from IPC and is narrowed here rather than
 * trusted, because a stale `main/` build is the one thing that can send
 * something unexpected down this channel.
 */
export async function recoverAutosaveEntry(payload: unknown): Promise<void> {
  const pick = asPick(payload);
  if (pick == null) {
    console.warn("[autosave] a recovery arrived with no entry", payload);
    return;
  }

  const filesystem = (globalThis as any).electronAPI?.req?.filesystem;
  if (filesystem?.readFile == null) {
    return;
  }

  // Imported lazily *at call time* rather than at module load: this module is
  // reached from `features/editor/menuCommands.ts`, and a static import of
  // `functions/project.ts` there would be a cycle through `index.ts`.
  const { default: project } = await import("../../functions/project");

  await recoverAutosave(
    pick,
    {
      isEmpty: () => isProjectEmpty(),
      isDirty: () => isProjectDirty(),
    },
    {
      readFile: (path) => filesystem.readFile(path),
      // `existFile` takes a real filesystem path, which is why `relinkAssets`
      // converts before it probes.
      exists: (fsPath) => filesystem.existFile(fsPath),
    },
    {
      adopt: (read) => project.adoptDocument(read, pick.file),
      setTitle: (title) => uiStore.getState().setTopBarTitle(title),
      // Never called. See the header.
      setProjectPath: () => {
        throw new Error(
          "A recovered session must stay detached; see recoverAutosave.ts",
        );
      },
      warn: (message) => project.showLoadFailure(message),
      toast: (message) =>
        (document.querySelector("toast-box") as any)?.showToast({
          message,
          delay: "5000",
        }),
      markRecovered: () =>
        autosaveSession()?.markRecovered(currentProjectDigest()),
    },
  );
}

function asPick(payload: unknown): AutosavePick | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const { key, file } = payload as { key?: unknown; file?: unknown };
  if (typeof key !== "string" || typeof file !== "string" || file === "") {
    return null;
  }
  return { key, file };
}
