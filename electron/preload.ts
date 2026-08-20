import { contextBridge, ipcRenderer } from "electron";

const request = {
  app: {
    forceClose: () => ipcRenderer.send("app:forceClose"),
    restart: () => ipcRenderer.send("app:restart"),
    getResourcesPath: () => ipcRenderer.invoke("app:getResourcesPath"),
    getTempPath: () => ipcRenderer.invoke("app:getTempPath"),
    getAppInfo: () => ipcRenderer.invoke("app:getAppInfo"),
  },
  dialog: {
    openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
    openFile: (extension) => ipcRenderer.invoke("dialog:openFile", extension),
    exportVideo: () => ipcRenderer.invoke("dialog:exportVideo"),
  },
  store: {
    set: (key, value) => ipcRenderer.invoke("store:set", key, value),
    get: (key) => ipcRenderer.invoke("store:get", key),
    delete: (key) => ipcRenderer.invoke("store:delete", key),
  },
  font: {
    getLists: () => ipcRenderer.invoke("font:getLists"),
    getLocalFontLists: () => ipcRenderer.invoke("font:getLocalFontLists"),
  },
  project: {
    save: () => ipcRenderer.invoke("dialog:saveProject"),
  },
  desktopCapturer: {
    getSources: () => ipcRenderer.invoke("desktopCapturer:getSources"),
  },
  overlayRecord: {
    show: () => ipcRenderer.invoke("overlayRecord:show"),
    stop: () => ipcRenderer.invoke("overlayRecord:stop"),
  },
  filesystem: {
    getDirectory: (dir) => ipcRenderer.invoke("filesystem:getDirectory", dir),
    openDirectory: (path) => ipcRenderer.send("OPEN_PATH", path),
    test: () => ipcRenderer.invoke("filesystem:test"),
    mkdir: (path, options) =>
      ipcRenderer.invoke("filesystem:mkdir", path, options),
    emptyDirSync: (path) => ipcRenderer.invoke("filesystem:emptyDirSync", path),
    removeDirectory: (path) =>
      ipcRenderer.invoke("filesystem:removeDirectory", path),

    writeFile: (filename, data, options) =>
      ipcRenderer.invoke("filesystem:writeFile", filename, data, options),
    readFile: (filename) => ipcRenderer.invoke("filesystem:readFile", filename),
    existFile: (filepath) =>
      ipcRenderer.invoke("filesystem:existFile", filepath),
    removeFile: (filepath) =>
      ipcRenderer.invoke("filesystem:removeFile", filepath),
  },
  progressBar: {
    test: () => ipcRenderer.send("PROGRESSBARTEST"),
  },
  ffmpeg: {
    getMetadata: (bloburl, mediapath) =>
      ipcRenderer.invoke("GET_METADATA", bloburl, mediapath),
    combineFrame: (outputDir, elementId) =>
      ipcRenderer.invoke("ffmpeg:combineFrame", outputDir, elementId),
    extractAudioFromVideo: (outputAudio, videoPath) =>
      ipcRenderer.invoke(
        "ffmpeg:extractAudioFromVideo",
        outputAudio,
        videoPath,
      ),
    installFFmpeg: () => ipcRenderer.send("DOWNLOAD_FFMPEG"),
  },
  render: {
    outputVideo: (elements, options) =>
      ipcRenderer.send("RENDER", elements, options),
    v2: {
      sendFrame: (base64Data) =>
        ipcRenderer.send("render:v2:sendFrame", base64Data),
      finishStream: () => ipcRenderer.send("render:v2:finishStream"),
      start: (options, timeline) =>
        ipcRenderer.send("render:v2:start", options, timeline),
    },
    offscreen: {
      readyToRender: () => ipcRenderer.invoke("render:offscreen:readyToRender"),
      start: (options, timeline) =>
        ipcRenderer.send("render:offscreen:start", options, timeline),
      sendFrame: (base64Data, pers) =>
        ipcRenderer.send("render:offscreen:sendFrame", base64Data, pers),
      finishStream: () => ipcRenderer.send("render:offscreen:finishStream"),
    },
  },
  url: {
    openUrl: (url) => ipcRenderer.send("OPEN_URL", url),
  },
  ai: {
    stt: (path) => ipcRenderer.invoke("ai:stt", path),
    text: (model, question) => ipcRenderer.invoke("ai:text", model, question),
    setKey: (key) => ipcRenderer.invoke("ai:setKey", key),
    getKey: () => ipcRenderer.invoke("ai:getKey"),
    runMcpServer: () => ipcRenderer.invoke("ai:runMcpServer"),
  },
  agent: {
    /** Answer one `agent:request`. See `electron/mcp/bridge.ts`. */
    respond: (id, response) => ipcRenderer.send("agent:response", id, response),
    getStatus: () => ipcRenderer.invoke("agent:getStatus"),
  },
  stream: {
    saveBufferToVideo: (arrayBuffer) =>
      ipcRenderer.invoke("stream:saveBufferToVideo", arrayBuffer),

    saveBufferToAudio: (arrayBuffer) =>
      ipcRenderer.invoke("stream:saveBufferToAudio", arrayBuffer),

    saveBufferToTempFile: (arrayBuffer, ext) =>
      ipcRenderer.invoke("stream:saveBufferToTempFile", arrayBuffer, ext),
  },
  ytdlp: {
    downloadVideo: (url, options) =>
      ipcRenderer.invoke("ytdlp:downloadVideo", url, options),
  },
  extension: {
    openDir: (dir) => ipcRenderer.invoke("extension:open:dir", dir),
    openFile: (file) => ipcRenderer.invoke("extension:open:file", file),
  },
  media: {
    backgroundRemove: (path) =>
      ipcRenderer.invoke("media:backgroundRemove", path),
  },
  selfhosted: {
    run: () => ipcRenderer.invoke("selfhosted:run"),
  },
};

const response = {
  app: {
    forceClose: (callback) => ipcRenderer.on("WHEN_CLOSE_EVENT", callback),
    getAppPath: (callback) => ipcRenderer.on("GET_PATH", callback),
  },
  auth: {
    loginSuccess: (callback) => ipcRenderer.on("LOGIN_SUCCESS", callback),
  },
  filesystem: {
    getAllDirectory: (callback) => ipcRenderer.on("RES_ALL_DIR", callback),
  },
  render: {
    progressing: (callback) => ipcRenderer.on("PROCESSING", callback),
    finish: (callback) => ipcRenderer.on("PROCESSING_FINISH", callback),
    error: (callback) => ipcRenderer.on("PROCESSING_ERROR", callback),
    finishCombineFrame: (callback) =>
      ipcRenderer.on("FINISH_COMBINE_FRAME", callback),
    offscreen: {
      start: (callback) => ipcRenderer.on("render:offscreen:start", callback),
    },
  },
  overlayRecord: {
    stop: (callback) => ipcRenderer.on("overlayRecord:stop:res", callback),
  },
  ffmpeg: {
    getMetadata: (callback) => ipcRenderer.on("GET_METADATA", callback),
    extractAudioFromVideoProgress: (callback) =>
      ipcRenderer.on("ffmpeg:extractAudioFromVideo:progress", callback),
    extractAudioFromVideoFinish: (callback) =>
      ipcRenderer.on("ffmpeg:extractAudioFromVideo:finish", callback),
  },
  ytdlp: {
    finish: (callback) => ipcRenderer.on("ytdlp:finish", callback),
  },
  shortcut: {
    controlS: (callback) => ipcRenderer.on("SHORTCUT_CONTROL_S", callback),
    controlO: (callback) => ipcRenderer.on("SHORTCUT_CONTROL_O", callback),
  },
  timeline: {
    get: (callback) => ipcRenderer.on("timeline:get", callback),
    add: (callback) => ipcRenderer.on("timeline:add", callback),
  },
  agent: {
    /** `(event, id, command, params)` — reply via `req.agent.respond(id, …)`. */
    onRequest: (callback) => ipcRenderer.on("agent:request", callback),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electronAPI", {
      req: request,
      res: response,
    });
  } catch (error) {
    console.error(error);
  }
}
