import { shell } from "electron";

export const shellLib = {
  openUrl: async (evt, url) => {
    shell.openExternal(url);
  },
  openPath: async (evt, path) => {
    shell.openPath(path);
  },
  /**
   * Reveal a *file* in the OS file manager, selected.
   *
   * `openPath` on a file opens it — an exported .mp4 would launch a video
   * player — which is not what "Open Saved Folder" means.
   */
  showItemInFolder: async (evt, path) => {
    shell.showItemInFolder(path);
  },
};
