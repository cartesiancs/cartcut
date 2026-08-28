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

          timelineStore.patchDocument(
            {
              schemaVersion: SCHEMA_VERSION,
              tracks,
              elements,
            },
            { bakeHz: projectBakeHz() },
          );

          project.changeProjectFileValue({ projectDestination: filepath });

          // Baseline the change detector against what was just loaded.
          // Without this the freshly opened project immediately reads as
          // "modified" and blocks opening another one.
          elementTimeline.appendCheckpointInHashTable();
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
