import { contextBridge, ipcRenderer, webUtils } from "electron";

const request = {
  /**
   * The path behind a dropped `File`.
   *
   * Electron removed the non-standard `File.path` in v32, and this app is on
   * 33 — so `e.dataTransfer.files[0].path` reads `undefined` and OS file drops
   * silently did nothing. `webUtils` only exists here, because the renderer
   * runs with `contextIsolation: true`.
   *
   * Not an `invoke`, and it cannot become one: a `File` does not survive IPC.
   * The renderer has to call this synchronously, inside the `drop` handler,
   * with the object the event handed it.
   */
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  /**
   * The native text-editing commands, by name.
   *
   * Only `features/editor/textEditing.ts` calls these, and only while the
   * caret is in a text field: the Edit menu's items are the editor's clip
   * commands now, so this is what keeps ⌘C in a caption meaning "copy the
   * text". `electron/ipc/ipcEditing.ts` holds the allowlist.
   */
  editing: {
    run: (command) => ipcRenderer.send("editing:command", command),
  },
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
    /** Many paths, for Import Media. Resolves to `[]` when cancelled. */
    openFiles: (extension) => ipcRenderer.invoke("dialog:openFiles", extension),
    saveTemplate: () => ipcRenderer.invoke("dialog:saveTemplate"),
    exportVideo: (container?: string) =>
      ipcRenderer.invoke("dialog:exportVideo", container),
  },
  store: {
    set: (key, value) => ipcRenderer.invoke("store:set", key, value),
    get: (key) => ipcRenderer.invoke("store:get", key),
    delete: (key) => ipcRenderer.invoke("store:delete", key),
  },
  font: {
    getLists: () => ipcRenderer.invoke("font:getLists"),
    getLocalFontLists: () => ipcRenderer.invoke("font:getLocalFontLists"),
    getPresetFontLists: () => ipcRenderer.invoke("font:getPresetFontLists"),
  },
  /**
   * Effect and transition presets.
   *
   * `list` takes no arguments and there is no "read this file" call, which is
   * deliberate: everything a preset needs is read during enumeration, so the
   * renderer never hands the main process a path to open. See
   * `electron/lib/preset.ts`.
   */
  preset: {
    list: () => ipcRenderer.invoke("preset:list"),
    userDirectory: () => ipcRenderer.invoke("preset:userDirectory"),
    installLut: (name, extension, bytes) =>
      ipcRenderer.invoke("preset:installLut", name, extension, bytes),
  },
  /**
   * Templates. Enumeration and removal only.
   *
   * There is no `install` here on purpose: the renderer extracts a `.cttpl`
   * with JSZip and writes it out through `filesystem.writeFile` below, because
   * it already has the zip library and already owns the rule about what makes
   * an archive a template. See `electron/lib/template.ts`.
   */
  template: {
    list: () => ipcRenderer.invoke("template:list"),
    userDirectory: () => ipcRenderer.invoke("template:userDirectory"),
    remove: (id) => ipcRenderer.invoke("template:remove", id),
  },
  project: {
    save: () => ipcRenderer.invoke("dialog:saveProject"),
  },
  desktopCapturer: {
    getSources: () => ipcRenderer.invoke("desktopCapturer:getSources"),
  },
  /**
   * The recorder.
   *
   * `show` is the editor's only call — it opens the recorder and then has
   * nothing more to do with it until a finished file arrives on
   * `res.overlayRecord.complete`. Everything else here is called by the engine
   * renderer, which shares this preload.
   *
   * `append` is deliberately an `invoke`: it resolves once the write pipe has
   * room, and the encoder awaits that resolution as backpressure. The same
   * reason `render.v2.sendFrame` above is one.
   */
  overlayRecord: {
    show: () => ipcRenderer.invoke("overlayRecord:show"),
    close: () => ipcRenderer.invoke("overlayRecord:close"),
    sources: () => ipcRenderer.invoke("overlayRecord:sources"),
    platform: () => ipcRenderer.invoke("overlayRecord:platform"),
    permissions: () => ipcRenderer.invoke("overlayRecord:permissions"),
    requestPermission: (kind) =>
      ipcRenderer.invoke("overlayRecord:requestPermission", kind),
    setTray: (model) => ipcRenderer.invoke("overlayRecord:setTray", model),
    setOverlay: (state) =>
      ipcRenderer.invoke("overlayRecord:setOverlay", state),
    setDrawing: (value) =>
      ipcRenderer.invoke("overlayRecord:setDrawing", value),
    armDisplayMedia: (sourceId, audio) =>
      ipcRenderer.invoke("overlayRecord:armDisplayMedia", sourceId, audio),
    disarmDisplayMedia: () =>
      ipcRenderer.invoke("overlayRecord:disarmDisplayMedia"),
    start: (request) => ipcRenderer.invoke("overlayRecord:start", request),
    append: (sessionId, key, chunk) =>
      ipcRenderer.invoke("overlayRecord:append", sessionId, key, chunk),
    finishFile: (sessionId, key) =>
      ipcRenderer.invoke("overlayRecord:finishFile", sessionId, key),
    pause: (sessionId) => ipcRenderer.invoke("overlayRecord:pause", sessionId),
    resume: (sessionId) =>
      ipcRenderer.invoke("overlayRecord:resume", sessionId),
    // No session id: drawing works whether or not a take is running, and the
    // overlay has no reason to know which. See the handler in `ipcOverlayRecord`.
    stroke: (message) => ipcRenderer.invoke("overlayRecord:stroke", message),
    click: (sessionId, click) =>
      ipcRenderer.invoke("overlayRecord:click", sessionId, click),
    stop: (sessionId) => ipcRenderer.invoke("overlayRecord:stop", sessionId),
    deliver: (sessionId, request) =>
      ipcRenderer.invoke("overlayRecord:deliver", sessionId, request),
    cancel: () => ipcRenderer.invoke("overlayRecord:cancel"),
    openFolder: () => ipcRenderer.invoke("overlayRecord:openFolder"),
  },
  filesystem: {
    getDirectory: (dir) => ipcRenderer.invoke("filesystem:getDirectory", dir),
    openDirectory: (path) => ipcRenderer.send("OPEN_PATH", path),
    showItemInFolder: (path) =>
      ipcRenderer.send("SHOW_ITEM_IN_FOLDER", path),
    test: () => ipcRenderer.invoke("filesystem:test"),
    mkdir: (path, options) =>
      ipcRenderer.invoke("filesystem:mkdir", path, options),
    emptyDirSync: (path) => ipcRenderer.invoke("filesystem:emptyDirSync", path),
    removeDirectory: (path) =>
      ipcRenderer.invoke("filesystem:removeDirectory", path),

    writeFile: (filename, data, options) =>
      ipcRenderer.invoke("filesystem:writeFile", filename, data, options),
    // Awaited, directory-creating, and it reports failure — see the header on
    // `ipcFilesystem.writeFileEnsured` for why `writeFile` above cannot serve
    // a template install.
    writeFileEnsured: (filename, base64) =>
      ipcRenderer.invoke("filesystem:writeFileEnsured", filename, base64),
    readFile: (filename) => ipcRenderer.invoke("filesystem:readFile", filename),
    existFile: (filepath) =>
      ipcRenderer.invoke("filesystem:existFile", filepath),
    removeFile: (filepath) =>
      ipcRenderer.invoke("filesystem:removeFile", filepath),
    saveGeneratedAsset: (buffer, ext) =>
      ipcRenderer.invoke("filesystem:saveGeneratedAsset", buffer, ext),
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
      // All `invoke`: `start` must resolve after the spawn so frame 0 cannot
      // beat it, and `sendFrame` resolves only when the pipe has room — that
      // resolution is the backpressure signal the frame loop awaits.
      sendFrame: (frameBuffer, sessionId) =>
        ipcRenderer.invoke("render:v2:sendFrame", frameBuffer, sessionId),
      finishStream: (sessionId) =>
        ipcRenderer.invoke("render:v2:finishStream", sessionId),
      start: (options, timeline) =>
        ipcRenderer.invoke("render:v2:start", options, timeline),
      cancel: (sessionId) => ipcRenderer.invoke("render:v2:cancel", sessionId),
    },
    offscreen: {
      readyToRender: () => ipcRenderer.invoke("render:offscreen:readyToRender"),
      start: (options, timeline) =>
        ipcRenderer.invoke("render:offscreen:start", options, timeline),
      sendFrame: (frameBuffer, pers) =>
        ipcRenderer.invoke("render:offscreen:sendFrame", frameBuffer, pers),
      finishStream: () => ipcRenderer.invoke("render:offscreen:finishStream"),
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
  /**
   * Proxy media — small stand-ins the preview decodes instead of the originals.
   *
   * `generate` resolves only when the whole pass is done, which for a handful
   * of 4K sources is minutes, so the two listeners are how a caller shows
   * anything in the meantime. Both return an unsubscribe rather than relying on
   * the caller to reconstruct the same function reference for `removeListener`.
   */
  proxy: {
    list: () => ipcRenderer.invoke("proxy:list"),
    stats: () => ipcRenderer.invoke("proxy:stats"),
    inspect: (sources) => ipcRenderer.invoke("proxy:inspect", sources),
    generate: (sources, force) =>
      ipcRenderer.invoke("proxy:generate", sources, force),
    clear: () => ipcRenderer.invoke("proxy:clear"),
    onProgress: (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on("proxy:progress", wrapped);
      return () => ipcRenderer.removeListener("proxy:progress", wrapped);
    },
    onDone: (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on("proxy:done", wrapped);
      return () => ipcRenderer.removeListener("proxy:done", wrapped);
    },
  },
  /**
   * Clip reversal. `start(jobId, { source, fromMs, toMs })` resolves when the
   * reversed file exists — or with `{ ok: false, cancelled }` — and
   * `onProgress` hears `{ jobId, fraction, stage }` in the meantime. The job id
   * is minted by the caller so it can cancel before `start` resolves.
   */
  reverse: {
    start: (jobId, request) =>
      ipcRenderer.invoke("reverse:start", jobId, request),
    cancel: (jobId) => ipcRenderer.invoke("reverse:cancel", jobId),
    onProgress: (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on("reverse:progress", wrapped);
      return () => ipcRenderer.removeListener("reverse:progress", wrapped);
    },
  },
  /**
   * Speech-to-text. `start(jobId, { source, method, locale })` resolves with the
   * words already grouped into caption lines — or `{ ok: false, cancelled }` —
   * and `onProgress` hears `{ jobId, fraction, stage }` meanwhile. The stage
   * separates a first-run model download, which can be minutes, from the
   * transcription itself, which is seconds.
   *
   * The job id is minted by the caller so it can cancel that download before
   * `start` resolves.
   */
  transcribe: {
    locales: () => ipcRenderer.invoke("transcribe:locales"),
    start: (jobId, request) =>
      ipcRenderer.invoke("transcribe:start", jobId, request),
    cancel: (jobId) => ipcRenderer.invoke("transcribe:cancel", jobId),
    onProgress: (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on("transcribe:progress", wrapped);
      return () => ipcRenderer.removeListener("transcribe:progress", wrapped);
    },
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
    /**
     * FFmpeg exited nonzero. Distinct from `PROCESSING_ERROR`, which only the
     * legacy fluent path emits — this one fires for `render:v2`, including for
     * failures that surface after the last frame has been written.
     */
    v2Error: (callback) => ipcRenderer.on("render:v2:error", callback),
    v2Cancelled: (callback) => ipcRenderer.on("render:v2:cancelled", callback),
    finishCombineFrame: (callback) =>
      ipcRenderer.on("FINISH_COMBINE_FRAME", callback),
    offscreen: {
      start: (callback) => ipcRenderer.on("render:offscreen:start", callback),
    },
  },
  /**
   * Pushes from main.
   *
   * `complete` is the editor's whole involvement in a recording: `(event,
   * { path })`, once, when a finished file is on disk. `tray` and `overlay` go
   * to the recorder's own two windows.
   *
   * The old `stop` listener is gone with the stub it belonged to. Nothing ever
   * sent `overlayRecord:stop:res` except a tray item that also closed the
   * window, and `req.overlayRecord.stop` had no handler in main at all — an
   * `invoke` that could only ever reject.
   */
  overlayRecord: {
    complete: (callback) => ipcRenderer.on("overlayRecord:complete", callback),
    tray: (callback) => ipcRenderer.on("overlayRecord:tray", callback),
    overlay: (callback) => ipcRenderer.on("overlayRecord:overlay", callback),
    // Overlay -> engine, relayed by main: annotations to composite, and the
    // overlay's own request to leave drawing mode.
    stroke: (callback) => ipcRenderer.on("overlayRecord:stroke", callback),
    setDrawing: (callback) =>
      ipcRenderer.on("overlayRecord:setDrawing", callback),
  },
  ffmpeg: {
    // No `getMetadata` here. `GET_METADATA` is an `ipcMain.handle`, reached
    // through `req.ffmpeg.getMetadata`; the push-event listener that used to
    // sit here had no sender at all, and the one caller that waited on it
    // silently never placed its clip.
    extractAudioFromVideoProgress: (callback) =>
      ipcRenderer.on("ffmpeg:extractAudioFromVideo:progress", callback),
    extractAudioFromVideoFinish: (callback) =>
      ipcRenderer.on("ffmpeg:extractAudioFromVideo:finish", callback),
  },
  ytdlp: {
    finish: (callback) => ipcRenderer.on("ytdlp:finish", callback),
  },
  /**
   * The application menu, as one channel carrying a command id.
   *
   * Replaces the two `SHORTCUT_CONTROL_*` channels, which needed a new channel,
   * a new preload entry and a new listener for every item added to the menu.
   * The ids are `electron/lib/menuCommands.ts`; the renderer runs them in
   * `features/editor/menuCommands.ts`.
   */
  menu: {
    command: (callback) => ipcRenderer.on("menu:command", callback),
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
