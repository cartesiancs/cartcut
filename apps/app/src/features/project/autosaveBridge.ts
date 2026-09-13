/**
 * Wiring Auto Save to the running app. The impure half.
 *
 * `autosaveSession.ts` holds the state machine and knows nothing about stores,
 * the DOM or IPC; this builds the four ports it takes and subscribes to the
 * two stores. The `proxy/proxyBridge.ts` installer idiom: one `install*`
 * called from `index.ts`, returning a disposer for symmetry.
 *
 * ## The subscription gate is the performance of the whole feature
 *
 * `useTimelineStore` is plain `createStore` with no `subscribeWithSelector`,
 * so **every listener fires on every write of any field** — including
 * `setCursor` at the display rate during playback (`index.ts` says so where it
 * counts them). An ungated listener here would serialize the project sixty
 * times a second.
 *
 * The gate is two reference comparisons. `withCheckpoint` and the rest write
 * fresh `timeline`/`tracks` objects when they change something and return
 * `state` by identity when they do not, so identity is an exact answer to "did
 * the document change" — and the cursor writes leave both references alone.
 *
 * `autosave.noteChange` is counted beside `store.notify`, so the ratio is
 * visible from `__cartcutPerf` in the running app rather than reasoned about.
 */

import { v4 as uuidv4 } from "uuid";
import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { exportStore } from "../../states/exportStore";
import { backgroundTaskStore } from "../../states/backgroundTaskStore";
import { count as perfCount } from "../debug/frameStats";
import {
  keyForProjectFile,
  keyForSession,
  ringLabel,
  type AutosaveKey,
} from "./autosaveIdentity";
import {
  AutosaveSession,
  type AutosaveClock,
  type AutosaveSnapshot,
  type AutosaveWriter,
} from "./autosaveSession";
import { currentProjectDigest, projectBaseline } from "./projectDirty";
import { serializeProjectEntries } from "./projectEntries";
import { buildNgtBytes } from "./projectArchive";

/** The narrow part of the preload bridge Auto Save needs. */
type AutosaveIpc = {
  write: (
    key: string,
    bytes: Uint8Array,
    meta: { label: string; anchor: string | null },
  ) => Promise<unknown>;
  dropRings: (keys: string[]) => Promise<unknown>;
  list: () => Promise<unknown>;
};

function ipc(): AutosaveIpc | null {
  return (
    (globalThis as { electronAPI?: { req?: { autosave?: AutosaveIpc } } })
      ?.electronAPI?.req?.autosave ?? null
  );
}

/** This run of the app. What an unsaved project's ring is keyed by. */
const SESSION_ID = uuidv4();
const SESSION_STARTED_AT = Date.now();

/** `#projectFile` is where `functions/project.ts` keeps the current path. */
function projectFile(): string | null {
  const value = (document.querySelector("#projectFile") as any)?.value;
  return typeof value === "string" && value !== "" ? value : null;
}

/** A short local date for an untitled ring's label. */
function shortDate(atMs: number): string {
  return new Date(atMs).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The ring this project writes to.
 *
 * A `.ngt` path when there is one, otherwise this session. The session key is
 * *not* a fallback for a failed path read — it is the identity of a project
 * that has never been saved, which is the case the feature exists for.
 */
export function currentAutosaveKey(): AutosaveKey {
  const file = projectFile();
  return file == null ? keyForSession(SESSION_ID) : keyForProjectFile(file);
}

/**
 * Every ring a save to `destination` retires.
 *
 * Two, because one save can retire two identities: saving an untitled project
 * as `Film.ngt` supersedes this session's own ring *and* any ring already
 * sitting at `Film.ngt` from an earlier crash — the user has just written that
 * exact path, so anything there is older than the file now on disk.
 */
export function autosaveKeysRetiredBy(destination: string): AutosaveKey[] {
  const keys = new Set<AutosaveKey>([
    keyForSession(SESSION_ID),
    keyForProjectFile(destination),
  ]);
  const open = projectFile();
  if (open != null) {
    keys.add(keyForProjectFile(open));
  }
  return [...keys];
}

const TASK_ID = "autosave-failure";

function realClock(): AutosaveClock {
  return {
    now: () => Date.now(),
    setTimer: (ms, fn) => window.setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => window.clearTimeout(id),
  };
}

function realWriter(api: AutosaveIpc): AutosaveWriter {
  return {
    write: async (request) => {
      const answer = (await api.write(
        request.key,
        request.bytes,
        request.meta,
      )) as { ok?: boolean; file?: string; writtenAtMs?: number; error?: string };

      if (answer?.ok === true) {
        return {
          ok: true,
          file: answer.file ?? "",
          writtenAtMs: answer.writtenAtMs ?? Date.now(),
        };
      }
      return { ok: false, error: answer?.error ?? "the write was refused" };
    },
    dropRings: (keys) => api.dropRings(keys),
  };
}

/**
 * The snapshot, read at one instant.
 *
 * Returns `null` rather than throwing when the document cannot be read, which
 * the session treats as "defer". `#projectFile` lives in a Lit-rendered panel,
 * so an autosave firing before that has mounted is a real possibility on a
 * cold start, and it must cost nothing.
 *
 * The entries are serialized here and the *zip* is left as a thunk, so a
 * project that has not changed costs one `JSON.stringify` of the document and
 * no compression at all.
 */
function realSource(): { snapshot: () => AutosaveSnapshot | null } {
  return {
    snapshot: () => {
      try {
        const state = useTimelineStore.getState();
        const options = renderOptionStore.getState().options;
        const file = projectFile();

        // The anchor is the `.ngt` this stands in for — never the cache file
        // being written. Anchoring on the cache would make
        // `serializeAssetPaths` emit nothing, because no asset is inside
        // `userData/autosave/`. See `projectEntries.ts`.
        const anchor = file;

        const entries = serializeProjectEntries({
          elements: state.timeline,
          tracks: state.tracks,
          options: options,
          // With no `.ngt` yet there is nothing to be relative to, so the
          // document's absolute paths are all the archive can carry — which is
          // correct for a project that has never been saved anywhere.
          anchor: anchor ?? "",
          previewRatio:
            (document.querySelector("element-control") as any)?.previewRatio ??
            1,
        });

        return {
          digest: currentProjectDigest(),
          baseline: projectBaseline(),
          key: currentAutosaveKey(),
          label: ringLabel(file, SESSION_STARTED_AT, shortDate),
          anchor: anchor,
          bytes: () =>
            buildNgtBytes(entries, {
              // The sixth entry. `project.load` reads five *named* entries and
              // ignores the rest, so this does not move `SCHEMA_VERSION`, and
              // it never appears in a user-saved `.ngt`. It exists so each
              // archive is self-sufficient: a lost `meta.json` must not make a
              // ring unrecoverable.
              "autosave.json": JSON.stringify({
                v: 1,
                anchor: anchor,
                writtenAtMs: Date.now(),
                sessionId: SESSION_ID,
              }),
            }),
        };
      } catch (error) {
        console.warn("[autosave] could not read the project", error);
        return null;
      }
    },
  };
}

let session: AutosaveSession | null = null;

/** The session, for `functions/project.ts` and the recovery path. */
export function autosaveSession(): AutosaveSession | null {
  return session;
}

/**
 * Start autosaving.
 *
 * A no-op with no bridge, which is the web build: `ipcWrapper` replaces
 * `window.electronAPI` wholesale and provides no `autosave`. The same `== null`
 * gate `templateExport.ts` uses, and the same reason — a feature that cannot
 * work there should do nothing rather than fail every few seconds.
 */
export function installAutosave(): () => void {
  const api = ipc();
  if (api == null) {
    return () => {};
  }

  const live = new AutosaveSession({
    clock: realClock(),
    writer: realWriter(api),
    source: realSource(),
    exportGate: { isBusy: () => exportStore.getState().phase !== "idle" },
    notifier: {
      report: (message) =>
        backgroundTaskStore.getState().add({
          id: TASK_ID,
          kind: "autosave",
          label: message,
          icon: "save",
          fraction: null,
          stage: "failing",
        }),
      clear: () => backgroundTaskStore.getState().remove(TASK_ID),
    },
  });
  session = live;

  // The gate. See the header: an ungated listener here serializes the project
  // at the display rate during playback.
  let lastElements = useTimelineStore.getState().timeline;
  let lastTracks = useTimelineStore.getState().tracks;

  const offTimeline = useTimelineStore.subscribe((state) => {
    if (state.timeline === lastElements && state.tracks === lastTracks) {
      return;
    }
    lastElements = state.timeline;
    lastTracks = state.tracks;
    perfCount("autosave.noteChange");
    live.noteChange();
  });

  // `updateOptions` always writes a fresh `options` object, so this fires only
  // on a real settings write — and the frame rate, the frame size and the
  // background colour are all in the file.
  let lastOptions = renderOptionStore.getState().options;
  const offOptions = renderOptionStore.subscribe((state) => {
    if (state.options === lastOptions) {
      return;
    }
    lastOptions = state.options;
    perfCount("autosave.noteChange");
    live.noteChange();
  });

  return () => {
    offTimeline();
    offOptions();
    live.stop();
    session = null;
  };
}
