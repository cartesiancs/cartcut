import { app, dialog } from "electron";
import fs from "fs";
import { mainWindow } from "../lib/window";
import path from "path";
import { v4 as uuidv4 } from "uuid";

/**
 * Make sure the saved file still names its own format.
 *
 * `showSaveDialog` normally appends the extension from `filters`, but a user
 * who types a name with a dot in it can defeat that — and a recording written
 * without `.webm` is one the importer refuses by extension, so the clip goes
 * missing for a reason nothing on screen explains.
 */
function withExtension(filePath: string, ext: string): string {
  return path.extname(filePath) === "" ? `${filePath}.${ext}` : filePath;
}

/** Write the blob, answering with a shape either way — never `undefined`. */
function writeBuffer(filePath: string, arrayBuffer): Promise<any> {
  return new Promise((resolve) => {
    fs.writeFile(filePath, arrayBuffer, async (err) => {
      if (err) {
        console.error("Failed to save file:", err);
        resolve({ status: false });
      } else {
        console.log("File saved successfully:", filePath);
        resolve({ status: true, path: filePath });
      }
    });
  });
}

export const ipcStream = {
  saveBufferToVideo: async (event, arrayBuffer) => {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save Video",
      buttonLabel: "Export",
      filters: [
        {
          name: "Export Video",
          extensions: ["webm"],
        },
      ],
      properties: [],
    });

    // Cancelling used to fall off the end returning `undefined`, which threw a
    // TypeError in the caller's `.then`. A cancel is not a failure; say so.
    if (!filePath) {
      return { status: false, canceled: true };
    }

    return writeBuffer(withExtension(filePath, "webm"), arrayBuffer);
  },

  saveBufferToAudio: async (event, arrayBuffer) => {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "Save Audio",
      buttonLabel: "Export",
      filters: [
        {
          name: "Export Audio",
          extensions: ["wav"],
        },
      ],
      properties: [],
    });

    if (!filePath) {
      return { status: false, canceled: true };
    }

    return writeBuffer(withExtension(filePath, "wav"), arrayBuffer);
  },

  saveBufferToTempFile: async (event, arrayBuffer, ext) => {
    const tmppath = app.getPath("temp");
    const filename = uuidv4() + "." + ext;

    const filePath = path.join(tmppath, filename);

    if (filePath) {
      const result = new Promise((resolve, reject) => {
        fs.writeFile(filePath, arrayBuffer, async (err) => {
          if (err) {
            console.error("Failed to save file:", err);
            resolve({
              status: false,
            });
          } else {
            console.log("file saved successfully:", filePath);
            resolve({
              status: true,
              path: filePath,
            });
          }
        });
      });

      return result;
    }
  },
};
