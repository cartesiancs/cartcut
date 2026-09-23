import { EXTENSIONS_ENTRY, parseExtensionsEntry } from "../features/extension/projectData";
import { extensionsExtraEntries, projectDataStore } from "../features/extension/projectDataStore";
import { useTimelineStore } from "../states/timelineStore";
import { rendererModal } from "../utils/modal";
import { uiStore } from "../states/uiStore";
import { renderOptionStore } from "../states/renderOptionStore";
import { deserializeRenderOptions } from "../features/project/renderOptionsFile";
import { projectBakeHz } from "../features/editor/frameRate";
import { registerDocumentFonts } from "../features/font/fontFaces";
import { arrayBufferToBase64 } from "../utils/base64";
import { serializeProjectEntries } from "../features/project/projectEntries";
import {
  isProjectDirty,
  markProjectSaved,
} from "../features/project/projectDirty";
import {
  autosaveKeysRetiredBy,
  autosaveSession,
} from "../features/project/autosaveBridge";
import {
  buildNgtBlob,
  openNgt,
  readNgtEntries,
  readNgtExtra,
} from "../features/project/projectArchive";
import {
  readProjectDocument,
  readProjectFailureMessage,
  type ReadProjectResult,
} from "../features/project/projectDocument";

const timelineStore = useTimelineStore.getState();
const uiState = uiStore.getState();

/**
 * What a save did.
 *
 * A discriminated outcome rather than a throw, because the three cases have
 * three different callers: ⌘S shows a toast, Auto Save drops a recovery ring
 * on `ok` alone, and a cancelled dialog is neither a success nor a failure.
 */
export type SaveOutcome =
  | { ok: true; path: string }
  | { ok: false; cancelled?: boolean; message: string };

const project = {
  /**
   * Write the project, asking where to put it if it has no path yet.
   *
   * **Returns a promise that settles on the bytes, not on the request.** It
   * used to return `0` and leave the write running in a `.then` nobody held,
   * so no caller could know whether a save had happened — which was survivable
   * only while nothing depended on the answer. Auto Save depends on it
   * completely: a successful save drops that project's recovery ring, so a
   * failure reported as success would delete the user's only unsaved copy.
   *
   * Cancelling the dialog is `{ ok: false, cancelled: true }`, which is not an
   * error and must not be reported as one.
   */
  save: async function (): Promise<SaveOutcome> {
    const projectFile = document.querySelector("#projectFile")?.value ?? "";

    if (projectFile != "") {
      return project.saveProjectFile({ projectDestination: projectFile });
    }

    const chosen = await window.electronAPI.req.project.save();
    // The dialog answers `undefined` on cancel; the web shim answers the
    // string "none". Neither is a destination.
    if (chosen == null || chosen === "" || chosen === "none") {
      return { ok: false, cancelled: true, message: "Save cancelled." };
    }

    return project.saveProjectFile({ projectDestination: chosen });
  },

  load: function () {
    // **Dirty only, deliberately not "non-empty".** A clean project is on
    // disk, so opening another loses nothing — refusing on non-empty would
    // mean never being able to open a second project. Auto Save recovery is
    // the surface that refuses on both, because it replaces everything.
    if (isProjectDirty()) {
      project.showLoadFailure(
        `This project has unsaved changes. Save it before opening another one.`,
      );
      return 0;
    }

    void project.openProjectFile();
  },

  /**
   * Open a `.ngt` the user picks.
   *
   * The read itself is `features/project/projectDocument.ts#readProjectDocument`
   * — the same function Auto Save recovery and the template registry go
   * through, so "does a recovered autosave load the way a project does" is one
   * code path rather than a hope. What is left here is the two halves that
   * belong to *this* surface: the dialog, and which modal a failure shows.
   */
  openProjectFile: async function (): Promise<void> {
    const filesystem = window.electronAPI?.req?.filesystem;
    if (filesystem == null) {
      return;
    }

    const picked = await window.electronAPI.req.dialog.openFile(["ngt"]);
    // Cancelling answers `undefined` (the web shim answers "none"), and
    // `clearTimeline()` below is unconditional — so Cancel used to empty the
    // timeline and then read a file called `undefined`. Nothing reported it,
    // because the read failed inside a promise nobody was holding.
    if (picked == null || picked === "" || picked === "none") {
      return;
    }

    const filepath: string = picked;

    let entries;
    let extensionsEntry: string | null = null;
    try {
      // One read of the archive, not two. The document and the project's
      // settings used to be pulled from separate `loadAsync` chains with no
      // ordering between them, which was harmless only while nothing in the
      // document depended on a setting. The frame rate does: it decides the
      // rate `patchDocument` re-derives baked animation at, so it has to be in
      // the store first.
      const zip = await openNgt(await filesystem.readFile(filepath));
      entries = await readNgtEntries(zip);
      // The sixth entry, read from the same archive so there is no second
      // open. `readNgtEntries` asks for five by name and ignores the rest,
      // which is what lets this be added without moving `SCHEMA_VERSION`.
      extensionsEntry = await readNgtExtra(zip, EXTENSIONS_ENTRY);
    } catch (error) {
      project.showLoadFailure(
        `This project could not be opened — ${String(error)}.`,
      );
      return;
    }

    // `existFile` takes a real filesystem path, which is why `relinkAssets`
    // converts before it probes — handing it a `file://` URL makes
    // `fsp.access` report a present file as missing.
    const read = await readProjectDocument(entries, filepath, (fsPath) =>
      filesystem.existFile(fsPath),
    );

    // Nothing has been touched yet, which is the point of reading before
    // clearing: a project that cannot be opened leaves the open one alone.
    if (!read.ok) {
      project.showLoadFailure(readProjectFailureMessage(read));
      return;
    }

    project.adoptDocument(read, filepath, extensionsEntry);
    project.changeProjectFileValue({ projectDestination: filepath });

    // Baseline against what was just loaded. Without this the freshly opened
    // project immediately reads as modified and blocks opening another one.
    //
    // From the **store**, not from the file: `patchDocument` normalizes and
    // may rebake on the way in, so the document now in the store is not
    // byte-identical to the `timeline.json` it came from.
    markProjectSaved();
  },

  /**
   * Put a read document into the stores.
   *
   * Shared with Auto Save recovery, because the order matters and is not
   * obvious: the render options go in **first**, so `patchDocument` re-derives
   * baked animation at the project's own frame rate rather than at the
   * previous project's.
   */
  adoptDocument: function (
    read: Extract<ReadProjectResult, { ok: true }>,
    _source: string,
    extensionsEntry: string | null = null,
  ): void {
    // Before the document, so an extension woken by `project.opened` finds its
    // own data already there rather than reading an empty store and caching
    // the answer.
    projectDataStore.getState().replace(parseExtensionsEntry(extensionsEntry));

    // Read against a *fresh* project's settings, so a field the file predates
    // falls back to the app's default rather than to whatever the previously
    // open project happened to leave in the store.
    renderOptionStore
      .getState()
      .updateOptions(
        deserializeRenderOptions(
          read.renderOptions,
          renderOptionStore.getInitialState().options,
        ),
      );

    timelineStore.clearTimeline();
    timelineStore.patchDocument(read.document, { bakeHz: projectBakeHz() });

    // Nothing else on the load path does this, so a text element naming a font
    // the user has not picked this session would draw in the fallback — in the
    // preview and in the export.
    registerDocumentFonts(read.document.elements);

    if (read.missing > 0) {
      // Counted in files rather than clips: twenty cuts of one missing video
      // are one thing to go and find.
      document.querySelector("toast-box")?.showToast({
        message:
          read.missing === 1
            ? `1 media file could not be found.`
            : `${read.missing} media files could not be found.`,
        delay: "5000",
      });
    }
  },

  showLoadFailure: function (message: string): void {
    rendererModal.whenTimelineChanged.show();
    const target = document.querySelector("#whenTimelineChangedMsg");
    if (target != null) {
      // `textContent`: this can carry a filesystem error string.
      target.textContent = message;
    }
  },

  saveProjectFile: async function ({
    projectDestination,
  }): Promise<SaveOutcome> {
    const { tracks, elements } = useTimelineStore.getState().getDocument();
    // Guarded: `previewRatio` is written into `renderOptions.json` and never
    // read back (`renderOptionsFile.ts` says so), so a missing component is
    // worth a default rather than a thrown save.
    const previewRatio =
      (document.querySelector("element-control") as any)?.previewRatio ?? 1;

    // The same function Auto Save writes through, which is what makes "an
    // autosave holds the same bytes a save would" a property of one call
    // rather than of two maintained copies. The destination is also the
    // anchor: a project saved here considers itself to live here.
    const entries = serializeProjectEntries({
      elements,
      tracks,
      options: renderOptionStore.getState().options,
      anchor: projectDestination,
      previewRatio,
    });

    // The sixth entry, or nothing at all. `extensionsExtraEntries` answers an
    // empty object when no extension has stored anything, so a project nobody
    // has run one on is byte-identical to a project saved before this existed.
    const content = await buildNgtBlob(entries, extensionsExtraEntries());
    const base64 = arrayBufferToBase64(await content.arrayBuffer());

    // `writeFileEnsured`, never `writeFile`. The latter calls the *callback*
    // form of `fs.writeFile` and returns before it runs, so it resolves
    // `undefined` whatever happened and a full disk came back looking exactly
    // like a successful save — the toast, the clean baseline and the retitled
    // window all fired anyway. See `ipcFilesystem.writeFileEnsured`.
    //
    // Absent means the web build, whose shim does not provide it. Saving was
    // already non-functional there; say so rather than adding a fallback that
    // keeps the lie alive.
    const filesystem = window.electronAPI?.req?.filesystem;
    if (filesystem?.writeFileEnsured == null) {
      return { ok: false, message: "Saving is not available in this build." };
    }

    const written = await filesystem.writeFileEnsured(
      projectDestination,
      base64,
    );

    if (written?.status !== true) {
      const message = written?.error
        ? `The project could not be saved: ${written.error}`
        : "The project could not be saved.";
      document
        .querySelector("toast-box")
        ?.showToast({ message: message, delay: "5000" });
      return { ok: false, message: message };
    }

    // Only now. Everything below says "the bytes are on disk", and every one
    // of these used to run on a write that had not been attempted yet.
    //
    // The baseline is the reason this ordering is load-bearing rather than
    // tidy: marking the project saved is what lets Auto Save drop its
    // recovery ring, so doing it on a write that failed would delete the
    // user's only unsaved copy.
    markProjectSaved();

    // The bytes are on disk, so the recovery ring for this project has
    // nothing left to recover. Dropped *after* the write and only on success:
    // dropping it before, or on a failure, would delete the user's only
    // unsaved copy. `autosaveKeysRetiredBy` answers with two identities
    // because a Save As retires the session's ring as well as the path's.
    void autosaveSession()
      ?.markSaved(autosaveKeysRetiredBy(projectDestination))
      .catch((error) => {
        // A ring that could not be dropped is stale, not dangerous: it shows
        // one extra recovery point in the menu. Never worth failing a save.
        console.warn("[autosave] could not retire the ring", error);
      });

    document
      .querySelector("toast-box")
      ?.showToast({ message: "Saved", delay: "2000" });

    project.changeProjectFileValue({
      projectDestination: projectDestination,
    });

    return { ok: true, path: projectDestination };
  },

  changeProjectFileValue: function ({ projectDestination }) {
    document.querySelector("#projectFile").value = projectDestination;
    uiState.setTopBarTitle(`CartCut - ${projectDestination}`);
  },
};

export default project;
