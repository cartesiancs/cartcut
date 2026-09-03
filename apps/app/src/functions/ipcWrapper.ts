import axios from "axios";
import { getLocationEnv } from "./getLocationEnv";
import { sampleDemoFileList } from "../data/sampleDemoFiles";

export function enableIpcWrapper() {
  if (getLocationEnv() == "electron") return false;

  window.electronAPI = {
    req: {
      app: {
        forceClose: async function (lang) {
          return "none";
        },
        restart: async function (lang) {
          return "none";
        },
        getResourcesPath: async function (lang) {
          return "none";
        },
        getTempPath: async function (lang) {
          const request = await axios.get(`/api/path/temp`);
          return request.data;
        },
        getAppInfo: async function (lang) {
          if (getLocationEnv() == "demo") {
            return {
              data: {
                version: "Demo",
              },
            };
          }

          return {
            data: {
              version: "SelfHosted",
            },
          };
        },
      },
      dialog: {
        openDirectory: async function (lang) {
          return "/";
        },
        openFile: async function (lang) {
          return "none";
        },
        exportVideo: async function (lang) {
          return "none";
        },
      },
      store: {
        set: async function (lang) {
          return "none";
        },
        get: async function (lang) {
          return "none";
        },
        delete: async function (lang) {
          return "none";
        },
      },
      font: {
        getLists: async function (lang) {
          return {
            fonts: [],
          };
        },
        getLocalFontLists: async function (lang) {
          return "none";
        },
        getPresetFontLists: async function () {
          return { status: 0, fonts: [] };
        },
      },
      project: {
        save: async function (lang) {
          return "none";
        },
      },
      desktopCapturer: {
        getSources: async function (lang) {
          return "none";
        },
      },
      overlayRecord: {
        show: async function (lang) {
          return "none";
        },
        stop: async function (lang) {
          return "none";
        },
      },
      filesystem: {
        getDirectory: async function (dir) {
          if (getLocationEnv() == "demo") {
            return sampleDemoFileList;
          }

          const request = await axios.get(`/api/directory?dir=${dir}`);
          return request.data;
        },
        openDirectory: async function (lang) {
          return "none";
        },
        mkdir: async function (lang) {
          return "none";
        },
        emptyDirSync: async function (lang) {
          return "none";
        },
        removeDirectory: async function (lang) {
          return "none";
        },

        writeFile: async function (lang) {
          return "none";
        },
        readFile: async function (lang) {
          return "none";
        },
        existFile: async function (lang) {
          return "none";
        },
        removeFile: async function (lang) {
          return "none";
        },
        saveGeneratedAsset: async function () {
          return { status: false, error: "not available in the web build" };
        },
      },
      ai: {
        getKey: async function (lang) {
          return "";
        },
        setKey: async function (lang) {
          return "";
        },
      },

      ffmpeg: {
        getMetadata: async function (bloburl, mediapath) {
          const request = await axios.get(
            `/api/file/metadata?path=${mediapath}`,
          );
          return request.data;
        },
        combineFrame: async function (lang) {
          return "none";
        },
        extractAudioFromVideo: async function (lang) {
          return "none";
        },
        installFFmpeg: async function (lang) {
          return "none";
        },
      },
      render: {
        outputVideo: async function (lang) {
          return "none";
        },
        v2: {
          sendFrame: async function (lang) {
            return "none";
          },
          finishStream: async function (lang) {
            return "none";
          },
          start: async function (lang) {
            return "none";
          },
        },
      },
      url: {
        openUrl: async function (lang) {
          return "none";
        },
      },
      stream: {
        saveBufferToVideo: async function (lang) {
          return "none";
        },

        saveBufferToAudio: async function (lang) {
          return "none";
        },

        saveBufferToTempFile: async function (lang) {
          return "none";
        },
      },
      extension: {
        openDir: async function (lang) {
          return "none";
        },
        openFile: async function (lang) {
          return "none";
        },
      },
      media: {
        backgroundRemove: async function (lang) {
          return "none";
        },
      },
    },
    res: {
      app: {
        forceClose: async function (lang) {
          return "none";
        },
        getAppPath: async function (lang) {
          return "none";
        },
      },
      auth: {
        loginSuccess: async function (lang) {
          return "none";
        },
      },
      filesystem: {
        getAllDirectory: async function (lang) {
          return "none";
        },
      },
      render: {
        progressing: async function (lang) {
          return "none";
        },
        finish: async function (lang) {
          return "none";
        },
        error: async function (lang) {
          return "none";
        },
        finishCombineFrame: async function (lang) {
          return "none";
        },
      },
      overlayRecord: {
        stop: async function (lang) {
          return "none";
        },
      },
      ffmpeg: {
        // Mirrors preload: `getMetadata` is request/response only, under `req`.
        extractAudioFromVideoProgress: async function (lang) {
          return "none";
        },
        extractAudioFromVideoFinish: async function (lang) {
          return "none";
        },
      },
      shortcut: {
        controlS: async function (lang) {
          return "none";
        },
        controlO: async function (lang) {
          return "none";
        },
      },
      timeline: {
        get: async function (lang) {
          return "none";
        },
        add: async function (lang) {
          return "none";
        },
      },
    },
  };
}
