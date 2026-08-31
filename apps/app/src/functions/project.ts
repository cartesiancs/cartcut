import JSZip from "jszip";
import { useTimelineStore } from "../states/timelineStore";
import { rendererModal } from "../utils/modal";
import { uiStore } from "../states/uiStore";
import { renderOptionStore } from "../states/renderOptionStore";
import { SCHEMA_VERSION } from "../features/timeline/tracks";
import {
  deserializeRenderOptions,
  serializeRenderOptions,
} from "../features/project/renderOptionsFile";
import { projectBakeHz } from "../features/editor/frameRate";
import {
  relinkAssets,
  serializeAssetPaths,
} from "../features/project/assetsFile";
import { registerDocumentFonts } from "../features/font/fontFaces";

const arrayBufferToBase64 = (buffer) => {
  var binary = "";
  var bytes = new Uint8Array(buffer);
  var len = bytes.byteLength;
  for (var i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
};

const timelineStore = useTimelineStore.getState();
const uiState = uiStore.getState();

const project = {
  save: function () {
    const projectFile = document.querySelector("#projectFile").value;

    if (projectFile != "") {
      project.saveProjectFile({ projectDestination: projectFile });
      return 0;
    } else {
      window.electronAPI.req.project.save().then((result) => {
        let projectDestination = result || `nonefile`;
        if (projectDestination == `nonefile`) {
          return 0;
        }

        project.saveProjectFile({ projectDestination: projectDestination });
      });
    }
  },

  load: function () {
    const elementTimeline = document.querySelector("element-timeline");
    const isTimelineChange = elementTimeline.isTimelineChange();
    if (isTimelineChange == true) {
      rendererModal.whenTimelineChanged.show();
      document.querySelector(
        "#whenTimelineChangedMsg",
      ).innerHTML = `Needs to restart.`;
      return 0;
    }

    window.electronAPI.req.dialog.openFile(["ngt"]).then((path) => {
      console.log("saved!", path);

      timelineStore.clearTimeline();

      let filepath = path;

      window.electronAPI.req.filesystem.readFile(filepath).then((data) => {
        // One read of the archive, not two. The document and the project's
        // settings used to be pulled from separate `loadAsync` chains with no
        // ordering between them, which was harmless only while nothing in the
        // document depended on a setting. The frame rate does: it decides the
        // rate `patchDocument` re-derives baked animation at, so it has to be
        // in the store first.
        JSZip.loadAsync(data).then(async function (zip: any) {
          // Projects written before tracks existed have no `project.json` and
          // no `tracks.json`; their elements carry a hand-assigned `priority`
          // that doubled as a row index, and `trim` under the old reading. There
          // is no migration, so say so plainly rather than opening something
          // that would look subtly wrong and export differently.
          const versionEntry = zip.file("project.json");
          const schemaVersion = versionEntry
            ? JSON.parse(await versionEntry.async("string")).schemaVersion
            : 1;

          if (schemaVersion !== SCHEMA_VERSION) {
            rendererModal.whenTimelineChanged.show();
            document.querySelector("#whenTimelineChangedMsg").innerHTML =
              `This project was made with an older version of Cartcut ` +
              `(format v${schemaVersion}) and cannot be opened by this one ` +
              `(format v${SCHEMA_VERSION}).`;
            return;
          }

          const optionsEntry = zip.file("renderOptions.json");
          const rawOptions = optionsEntry
            ? JSON.parse(await optionsEntry.async("string"))
            : null;

          // Read against a *fresh* project's settings, so a field the file
          // predates falls back to the app's default rather than to whatever
          // the previously open project happened to leave in the store.
          renderOptionStore
            .getState()
            .updateOptions(
              deserializeRenderOptions(
                rawOptions,
                renderOptionStore.getInitialState().options,
              ),
            );

          const elements = JSON.parse(
            await zip.file("timeline.json").async("string"),
          );
          const tracksEntry = zip.file("tracks.json");
          const tracks = tracksEntry
            ? JSON.parse(await tracksEntry.async("string"))
            : [];

          const assetsEntry = zip.file("assetPaths.json");
          const rawAssets = assetsEntry
            ? JSON.parse(await assetsEntry.async("string"))
            : null;

          // Point every asset at a file that is actually there: the path
          // recorded relative to *this* copy of the project folder first, then
          // the absolute one the document already carried. A project written
          // by an older build has no entry and comes through untouched.
          //
          // This runs BEFORE `patchDocument`, and the order is load-bearing in
          // two ways. The document reaching the store is the one the user will
          // see, so relinking afterwards would be a second, visible mutation;
          // and `appendCheckpointInHashTable` below hashes the store's
          // timeline to baseline the change detector, so a relink landing
          // after it would make a freshly opened project read as "modified"
          // and refuse to let another one be opened.
          const relink = await relinkAssets(
            elements,
            rawAssets,
            filepath,
            // `existFile` takes a real filesystem path, which is why
            // `relinkAssets` converts before it probes — handing it a
            // `file://` URL makes `fsp.access` report a present file as
            // missing.
            (fsPath) => window.electronAPI.req.filesystem.existFile(fsPath),
          );

          timelineStore.patchDocument(
            {
              schemaVersion: SCHEMA_VERSION,
              tracks,
              elements: relink.elements,
            },
            { bakeHz: projectBakeHz() },
          );

          // Nothing else on the load path does this, so a text element naming
          // a font the user has not picked this session would draw in the
          // fallback — in the preview and in the export.
          registerDocumentFonts(relink.elements);

          project.changeProjectFileValue({ projectDestination: filepath });

          // Baseline the change detector against what was just loaded.
          // Without this the freshly opened project immediately reads as
          // "modified" and blocks opening another one.
          elementTimeline.appendCheckpointInHashTable();

          if (relink.missing > 0) {
            // Counted in files rather than clips: twenty cuts of one missing
            // video are one thing to go and find.
            document.querySelector("toast-box")?.showToast({
              message:
                relink.missing === 1
                  ? `1 media file could not be found.`
                  : `${relink.missing} media files could not be found.`,
              delay: "5000",
            });
          }
        });
      });
    });

    const upload = document.createElement("input");
    upload.setAttribute("type", "file");
    upload.setAttribute("accept", ".ngt");
  },

  saveProjectFile: function ({ projectDestination }) {
    const elementTimeline = document.querySelector("element-timeline");
    const renderOptionState = renderOptionStore.getState().options;

    const { tracks, elements } = useTimelineStore.getState().getDocument();
    const projectRatio = document.querySelector("element-control").previewRatio;

    const zip = new JSZip();

    const options = serializeRenderOptions(renderOptionState, {
      previewRatio: projectRatio,
      videoDestination: projectDestination,
    });

    // `project.json` is what tells a future version which format this is; a
    // file without it predates tracks.
    zip.file("project.json", JSON.stringify({ schemaVersion: SCHEMA_VERSION }));
    zip.file("timeline.json", JSON.stringify(elements));
    zip.file("tracks.json", JSON.stringify(tracks));
    zip.file("renderOptions.json", JSON.stringify(options));

    // Relative paths for whatever sits inside this project's own folder, so
    // the folder can be handed to someone else and still find its media.
    // `timeline.json` keeps its absolute paths either way — they are the
    // fallback for a `.ngt` moved on its own, away from its assets.
    //
    // Anchored on `projectDestination` rather than on the previously opened
    // `#projectFile`: saving a template that was opened from somewhere else
    // has to re-relativize against where it is going now.
    zip.file(
      "assetPaths.json",
      JSON.stringify(serializeAssetPaths(elements, projectDestination)),
    );

    zip.generateAsync({ type: "blob" }).then(async function (content) {
      const buffer = arrayBufferToBase64(await content.arrayBuffer());

      window.electronAPI.req.filesystem
        .writeFile(projectDestination, buffer, "base64")
        .then((isCompleted) => {
          console.log("saved!");
          document
            .querySelector("toast-box")
            .showToast({ message: "Saved", delay: "2000" });

          elementTimeline.appendCheckpointInHashTable();
          project.changeProjectFileValue({
            projectDestination: projectDestination,
          });
          //fs.writeFile( projectDestination , buffer, () => {
        });
      //saveAs(content, `${projectFolder}/aaa.zip`);
    });
  },

  changeProjectFileValue: function ({ projectDestination }) {
    document.querySelector("#projectFile").value = projectDestination;
    uiState.setTopBarTitle(`Cartcut - ${projectDestination}`);
  },
};

export default project;
