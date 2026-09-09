import { dialog } from "electron";
import { mainWindow } from "../lib/window";

export const ipcDialog = {
  openDirectory: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
    });
    if (canceled) {
      return;
    } else {
      return filePaths[0];
    }
  },

  openFile: async (event, allowExtensions: string[] = ["*"]) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [
        {
          name: "File",
          extensions: allowExtensions,
        },
      ],
    });
    if (canceled) {
      return;
    } else {
      return filePaths[0];
    }
  },

  // `ipcMain.handle` puts the event first, so the container arrives second —
  // same shape as `openFile` above.
  exportVideo: async (event, container: string = "mp4") => {
    const extension = ["mp4", "mov", "webm"].includes(container)
      ? container
      : "mp4";

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Export the File Path to save",
      buttonLabel: "Export",
      filters: [
        {
          name: "Export Video",
          extensions: [extension],
        },
      ],
      properties: [],
    });
    if (!canceled) {
      return filePath.toString();
    }
  },

  /**
   * Where to write a `.cttpl`.
   *
   * Its own dialog rather than a parameter on `saveProject`, because the two
   * mean different things to the user — one keeps working on this project, the
   * other publishes a copy of it — and because the extension filter is what
   * makes the platform append `.cttpl` rather than `.ngt`.
   */
  saveTemplate: async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Export Template",
      buttonLabel: "Export",
      filters: [
        {
          name: "Cartcut Template",
          extensions: ["cttpl"],
        },
      ],
      properties: [],
    });
    if (!canceled) {
      return filePath.toString();
    }
  },

  saveProject: async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save the Project Path to save",
      buttonLabel: "Save",
      filters: [
        {
          name: "Save Project",
          extensions: ["ngt"],
        },
      ],
      properties: [],
    });
    if (!canceled) {
      return filePath.toString();
    }
  },
};
