/**
 * The `cartcut` module, as an extension sees it.
 *
 * Types only. There is no runtime here: `require("cartcut")` is answered by
 * the extension host with an object built for your extension, so what you
 * install this package for is the shape, not the code.
 *
 * Everything returns a promise, because everything crosses a process boundary.
 * That is the design rather than an inconvenience: your extension runs in its
 * own process, so nothing it does can freeze the editor, and nothing the
 * editor does can be reached except through the calls below.
 */

declare module "cartcut" {
  export interface Disposable {
    dispose(): void;
  }

  /** Subscribe, and get back the handle that unsubscribes. */
  export type Event<T> = (listener: (event: T) => void) => Disposable;

  /** Anything that survives `JSON.stringify` unchanged. */
  export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

  /**
   * What `activate` is handed.
   *
   * Put every `Disposable` you create into `subscriptions`. They are disposed
   * in reverse order when your extension is disabled or the host shuts down,
   * which is the only cleanup that is guaranteed to run.
   */
  export interface ExtensionContext {
    readonly extensionId: string;
    /** Your own folder. Readable, and replaced wholesale when you update. */
    readonly extensionPath: string;
    readonly subscriptions: Disposable[];
    /** A folder that is yours and survives an update. Write here. */
    readonly globalStorageUri: string;
    /** Your settings as they stood at activation. `config.onDidChange` for later. */
    readonly config: Record<string, string | number | boolean>;
    /** The same object `require("cartcut")` returns, for ES module entries. */
    readonly cartcut: typeof import("cartcut");
    readonly log: {
      info(...args: unknown[]): void;
      warn(...args: unknown[]): void;
      error(...args: unknown[]): void;
    };
  }

  export interface EditResult {
    ok: boolean;
    reason?: string;
    created: string[];
    removed: string[];
    changed: string[];
    clips?: unknown[];
  }

  export interface BatchStep {
    name: string;
    params?: JsonValue;
  }

  export namespace commands {
    /**
     * Offer a command. Reachable from a keybinding, a menu and the panel.
     *
     * The id must be one your manifest declares, or nothing will route to it.
     */
    function registerCommand(
      id: string,
      handler: (args?: JsonValue, signal?: AbortSignal) => unknown,
    ): Disposable;

    /** Run one editor command. The same table Claude Code's tools run. */
    function executeCommand<T = unknown>(name: string, params?: JsonValue): Promise<T>;

    /**
     * Run several as **one undo step**.
     *
     * Steps run in order and each sees the previous one's result. If any step
     * throws, nothing is applied at all. Asynchronous commands are refused, as
     * are `undo`, `redo` and a few others that have no meaning inside a batch.
     */
    function batch(steps: BatchStep[]): Promise<EditResult>;

    /** Every command name the editor answers. */
    function list(): Promise<{ commands: string[] }>;
  }

  export namespace timeline {
    function overview(): Promise<unknown>;
    function listClips(query?: {
      offset?: number;
      limit?: number;
      filetype?: string;
      trackId?: string;
    }): Promise<unknown>;
    function getClip(elementId: string): Promise<Record<string, unknown>>;
    function getKeyframes(params: JsonValue): Promise<unknown>;
    function listCuts(params?: JsonValue): Promise<unknown>;

    function splitClip(params: { elementId: string; atMs: number[] }): Promise<EditResult>;
    function trimClip(params: { elementId: string; startMs?: number; endMs?: number }): Promise<EditResult>;
    function moveClips(params: JsonValue): Promise<EditResult>;
    function deleteClips(params: { elementIds: string[]; ripple?: boolean }): Promise<EditResult>;
    function duplicateClips(params: JsonValue): Promise<EditResult>;
    function removeRanges(params: JsonValue): Promise<EditResult>;
    function setClipSpeed(params: JsonValue): Promise<EditResult>;
    function updateClip(params: { elementId: string; patch: JsonValue }): Promise<EditResult>;
    function addText(params: {
      text: string;
      startMs: number;
      durationMs: number;
      style?: JsonValue;
    }): Promise<EditResult>;
    function addSubtitles(params: JsonValue): Promise<EditResult>;
    function addShape(params: JsonValue): Promise<EditResult>;
    function addTrack(params: { kind: string; index?: number }): Promise<EditResult>;
    function removeTrack(params: JsonValue): Promise<EditResult>;
    function moveTrack(params: JsonValue): Promise<EditResult>;
    function setBlendMode(params: JsonValue): Promise<EditResult>;
    function setLut(params: JsonValue): Promise<EditResult>;
    function setColorAdjustments(params: JsonValue): Promise<EditResult>;
    function setMask(params: JsonValue): Promise<EditResult>;
    function setShape(params: JsonValue): Promise<EditResult>;
    function setVideoFilters(params: JsonValue): Promise<EditResult>;
    function setTextFont(params: JsonValue): Promise<EditResult>;
    function applyAnimationPreset(params: JsonValue): Promise<EditResult>;
    function setAnimation(params: JsonValue): Promise<EditResult>;
    function addKeyframes(params: JsonValue): Promise<EditResult>;
    function removeKeyframes(params: JsonValue): Promise<EditResult>;
    function addTransition(params: JsonValue): Promise<EditResult>;
    function setTransition(params: JsonValue): Promise<EditResult>;
    function removeTransition(params: JsonValue): Promise<EditResult>;
    function addEffect(params: JsonValue): Promise<EditResult>;
    function setEffect(params: JsonValue): Promise<EditResult>;
    function getFx(params: JsonValue): Promise<unknown>;
    function groupClips(params: JsonValue): Promise<EditResult>;
    function ungroup(params: JsonValue): Promise<EditResult>;
    function createNull(params?: JsonValue): Promise<EditResult>;
    function setClipParent(params: JsonValue): Promise<EditResult>;
    /** A whole edit as one undo step. See the `apply_edit_plan` docs. */
    function applyEditPlan(plan: JsonValue): Promise<EditResult>;

    /**
     * Your own data on a clip, keyed by your extension id.
     *
     * Only you can read or write it. It is saved with the project, it survives
     * undo, split and duplicate, and it is invisible to Claude Code. Needs the
     * `project.write` permission. Cap: 64 KB per clip.
     */
    function getElementData<T extends JsonValue = JsonValue>(
      elementId: string,
    ): Promise<{ elementId: string; value: T | null }>;
    function setElementData(elementId: string, value: JsonValue | null): Promise<EditResult>;

    /** Fires once per undo step, not once per frame of a drag. */
    const onDidChange: Event<{
      version: number;
      clipCount: number;
      trackCount: number;
    }>;
  }

  export namespace selection {
    function get(): Promise<{ ids: string[] } | string[]>;
    function set(elementIds: string[]): Promise<unknown>;
    const onDidChange: Event<{ ids: string[] }>;
  }

  export namespace playback {
    function setPlayhead(atMs: number): Promise<unknown>;
    function play(): Promise<unknown>;
    function pause(): Promise<unknown>;
    /** At most once per animation frame, latest value wins. */
    const onDidChangePlayhead: Event<{ ms: number }>;
    const onDidChangeState: Event<{ isPlay: boolean }>;
  }

  export namespace project {
    function info(): Promise<{
      fps: number | null;
      previewSize: { w: number; h: number } | null;
      playheadMs: number;
      isPlay: boolean;
      locked: boolean;
      trackCount: number;
      clipCount: number;
    }>;

    /**
     * Data stored in the project file, keyed by your extension id.
     *
     * Not undoable, and it makes the project dirty. Needs `project.write`.
     */
    const data: {
      get<T extends JsonValue = JsonValue>(): Promise<{ value: T | null }>;
      set(value: JsonValue | null): Promise<unknown>;
    };

    const onDidOpen: Event<{ path: string | null; dir: string | null }>;
    const onDidSave: Event<{ path: string }>;
  }

  export namespace assets {
    function list(params?: JsonValue): Promise<unknown>;
    function importPaths(items: JsonValue): Promise<EditResult>;
    function reveal(path: string): Promise<unknown>;
  }

  export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export type Placement =
    | { mode: "docked"; side: "left" | "right" | "top" | "bottom"; sizePct?: number }
    | { mode: "floating"; rect: Rect };

  export namespace window {
    function showPanel(viewId: string, placement?: Placement): Promise<unknown>;
    function closePanel(viewId: string): Promise<unknown>;
    function showMessage(text: string, kind?: "info" | "warn" | "error"): Promise<unknown>;
    function setStatusItem(item: {
      id: string;
      text?: string;
      tooltip?: string;
      command?: string;
      alignment?: "left" | "right";
      priority?: number;
      remove?: true;
    }): Promise<unknown>;

    /** A row in the task tray, with a cancel button if you ask for one. */
    function withProgress<T>(
      options: { title?: string; cancellable?: boolean },
      task: (
        progress: { report(fraction: number | null, stage?: string): void },
        signal: AbortSignal,
      ) => Promise<T>,
    ): Promise<T>;

    /** Needs `fs.read`. Picking a folder also grants `fs` access to it. */
    function showOpenDialog(options?: {
      extensions?: string[];
      multiple?: boolean;
      directory?: boolean;
    }): Promise<string[]>;

    /** Needs `fs.write`. */
    function showSaveDialog(options?: {
      defaultName?: string;
      extensions?: string[];
    }): Promise<string | null>;
  }

  export namespace ui {
    /** Messages from one of your webview pages. */
    function onViewMessage(viewId: string, listener: (message: JsonValue) => void): Disposable;
    /** An empty `viewId` broadcasts to every view you have open. */
    function postMessageToView(viewId: string, message: JsonValue): Promise<unknown>;
  }

  /**
   * Files, inside what you were given.
   *
   * Your own storage, your own folder, the project folder, and any folder the
   * user picked for you this session. Needs `fs.read` or `fs.write`. Writing
   * into your own installed folder is refused: an update replaces it.
   */
  export namespace fs {
    function readFile(path: string): Promise<Uint8Array>;
    function readText(path: string): Promise<string>;
    function readdir(path: string): Promise<string[]>;
    function stat(path: string): Promise<{ size: number; isDirectory: boolean; mtimeMs: number }>;
    function writeFile(path: string, data: Uint8Array | string): Promise<void>;
    function mkdir(path: string): Promise<void>;
    function storageDir(): string;
  }

  /** Needs `process.spawn`. */
  export namespace process {
    function ffmpegPath(): Promise<string>;
    function ffprobePath(): Promise<string>;
    function spawn(
      command: string,
      args?: string[],
      options?: {
        cwd?: string;
        signal?: AbortSignal;
        onStdout?: (chunk: string) => void;
        onStderr?: (chunk: string) => void;
      },
    ): Promise<{ code: number | null }>;
  }

  /** Needs `net`. */
  export namespace net {
    function fetch(input: string, init?: unknown): Promise<unknown>;
  }

  export namespace config {
    function get<T extends string | number | boolean = string | number | boolean>(
      key?: string,
    ): Promise<T>;
    function set(key: string, value: JsonValue): Promise<unknown>;
    const onDidChange: Event<Record<string, string | number | boolean>>;
  }

  export namespace storage {
    function get<T extends JsonValue = JsonValue>(key: string): Promise<T | null>;
    function set(key: string, value: JsonValue): Promise<unknown>;
    function delete_(key: string): Promise<unknown>;
  }

  /** Needs `secrets`. Kept in the system keychain, never in a readable file. */
  export namespace secrets {
    function get(key: string): Promise<string | null>;
    function set(key: string, value: string): Promise<unknown>;
  }

  /** Needs `ai.tools`. The tool appears to Claude Code as `ext_<you>_<name>`. */
  export namespace ai {
    function registerTool(tool: {
      name: string;
      description: string;
      inputSchema?: JsonValue;
      handler: (args: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
    }): Disposable;
  }

  export namespace exports {
    function onWillExport(listener: (event: JsonValue) => unknown): Disposable;
    function onDidExport(listener: (event: { path: string }) => void): Disposable;
  }

  /** Needs `shell.open`. */
  export namespace shell {
    function open(target: string): Promise<unknown>;
  }

  /** Needs `clipboard`. */
  export namespace clipboard {
    function read(): Promise<string>;
    function write(text: string): Promise<unknown>;
  }
}

/** Inside a webview page, this is the only thing on `window` that is ours. */
declare function acquireCartcutApi(): {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  getState(): unknown;
  setState(state: unknown): void;
};
