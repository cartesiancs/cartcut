/**
 * The `cartcut` object an extension imports, built once per extension.
 *
 * Every namespace here is one of three things: a call on the direct port to
 * the editor, a call on the main port, or local Node behind a permission
 * check. There is nothing else it could be, which is the property worth
 * protecting: an extension's whole reach is the list below, and a reviewer can
 * read it in one sitting.
 *
 * Two rules run through all of it.
 *
 * **The editor is reached only through registered commands.** `timeline.*` and
 * friends are typed wrappers over `commands.execute`, so every edit an
 * extension makes takes the same path a Claude Code tool call takes, lands in
 * one `withCheckpoint`, and respects the caption-session lock. There is no
 * method that hands over the document.
 *
 * **A permission is checked before Node is touched, not after.** The check is
 * cheap and the failure is a clear message naming the permission; doing it
 * after would mean a refused call had already opened the file.
 */

import * as fsp from "fs/promises";
import path from "path";
import { spawn } from "child_process";

import { hasPermission, type Permission } from "./permissions";
import { isInside } from "./paths";
import { RpcError } from "./rpc";
import { LONG_TIMEOUT_MS, SHORT_TIMEOUT_MS } from "./protocol";
import type { ExtensionManifest } from "./manifest";

export type Disposable = { dispose(): void };

export type CommandHandler = (args?: unknown, signal?: AbortSignal) => unknown;
export type ToolHandler = (args: unknown, signal: AbortSignal) => Promise<unknown>;

export type ApiDeps = {
  extId: string;
  manifest: ExtensionManifest;
  /** The extension's own folder. Readable without `fs.read`: it is its own code. */
  dir: string;
  /** Its writable corner under `userData`. Writable without `fs.write`. */
  dataDir: string;
  callEditor(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  callMain(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  log(level: "info" | "warn" | "error", args: unknown[]): void;
  registerCommand(id: string, handler: CommandHandler): Disposable;
  registerTool(name: string, description: string, inputSchema: unknown, handler: ToolHandler): Disposable;
  onEvent(name: string, listener: (params: unknown) => void): Disposable;
  onViewMessage(viewId: string, listener: (message: unknown) => void): Disposable;
  onExportWill(listener: (event: unknown) => unknown): Disposable;
  onExportDid(listener: (event: unknown) => void): Disposable;
  /** The project folder, or null. Tracked from `project.opened`. */
  projectDir(): string | null;
  /** Folders the user picked this session, which `fs` then admits. */
  grantedDirs(): string[];
  grantDir(dir: string): void;
};

function requirePermission(deps: ApiDeps, permission: Permission, what: string): void {
  if (!hasPermission(deps.manifest.permissions, permission)) {
    throw new RpcError(
      "E_PERMISSION",
      what + " needs the `" + permission + "` permission. Add it to your manifest.",
    );
  }
}

/**
 * Whether a path is one this extension may touch.
 *
 * Three roots and no more: its own folder, its own data directory, and
 * whatever the user pointed at this session. The project folder is in the list
 * because an extension that renders a sidecar file beside the project is the
 * common case; a path outside all of them is refused with the list named, so
 * the author can see that the answer is `showOpenDialog` rather than a longer
 * relative path.
 */
function assertAllowedPath(deps: ApiDeps, target: string, write: boolean): string {
  const resolved = path.resolve(target);
  const roots = [deps.dataDir, deps.dir, ...deps.grantedDirs()];
  const projectDir = deps.projectDir();
  if (projectDir != null) {
    roots.push(projectDir);
  }

  const allowed = roots.some((root) => resolved === path.resolve(root) || isInside(path.resolve(root), resolved));
  if (!allowed) {
    throw new RpcError(
      "E_PERMISSION",
      "`" + resolved + "` is outside this extension's reach. It may use its own storage, its own folder, the project folder, and folders the user picks with window.showOpenDialog.",
    );
  }
  // Writing into the extension's own installed folder is refused even though
  // reading it is free: an update replaces that directory wholesale, so
  // anything written there is lost at the next version with no warning.
  if (write && (resolved === path.resolve(deps.dir) || isInside(path.resolve(deps.dir), resolved))) {
    throw new RpcError(
      "E_PERMISSION",
      "an extension cannot write into its own installed folder, which is replaced on update. Use ctx.globalStorageUri.",
    );
  }
  return resolved;
}

/** One editor command, as a typed wrapper. Keeps the call sites honest. */
function editorCommand(deps: ApiDeps, name: string, timeoutMs?: number) {
  return (params: unknown = {}) => deps.callEditor("commands.execute", { name, params }, timeoutMs);
}

export function createExtensionApi(deps: ApiDeps): Record<string, unknown> {
  const commands = {
    registerCommand: (id: string, handler: CommandHandler) => deps.registerCommand(id, handler),
    executeCommand: (name: string, params: unknown = {}) =>
      deps.callEditor("commands.execute", { name, params }),
    batch: (steps: unknown) => deps.callEditor("commands.batch", { steps }, LONG_TIMEOUT_MS),
    list: () => deps.callEditor("commands.list", {}, SHORT_TIMEOUT_MS),
  };

  const timeline = {
    overview: editorCommand(deps, "get_project_overview"),
    listClips: editorCommand(deps, "list_clips"),
    getClip: (elementId: string) =>
      deps.callEditor("commands.execute", { name: "get_clip", params: { elementId } }),
    getKeyframes: editorCommand(deps, "get_keyframes"),
    listCuts: editorCommand(deps, "list_cuts"),
    splitClip: editorCommand(deps, "split_clip"),
    trimClip: editorCommand(deps, "trim_clip"),
    moveClips: editorCommand(deps, "move_clips"),
    deleteClips: editorCommand(deps, "delete_clips"),
    duplicateClips: editorCommand(deps, "duplicate_clips"),
    removeRanges: editorCommand(deps, "remove_ranges"),
    setClipSpeed: editorCommand(deps, "set_clip_speed"),
    updateClip: editorCommand(deps, "update_clip"),
    addText: editorCommand(deps, "add_text"),
    addSubtitles: editorCommand(deps, "add_subtitles"),
    addShape: editorCommand(deps, "add_shape"),
    addTrack: editorCommand(deps, "add_track"),
    removeTrack: editorCommand(deps, "remove_track"),
    moveTrack: editorCommand(deps, "move_track"),
    setBlendMode: editorCommand(deps, "set_blend_mode"),
    setLut: editorCommand(deps, "set_lut"),
    setColorAdjustments: editorCommand(deps, "set_color_adjustments"),
    setMask: editorCommand(deps, "set_mask"),
    setShape: editorCommand(deps, "set_shape"),
    setVideoFilters: editorCommand(deps, "set_video_filters"),
    setTextFont: editorCommand(deps, "set_text_font"),
    applyAnimationPreset: editorCommand(deps, "apply_animation_preset"),
    setAnimation: editorCommand(deps, "set_animation"),
    addKeyframes: editorCommand(deps, "add_keyframes"),
    removeKeyframes: editorCommand(deps, "remove_keyframes"),
    addTransition: editorCommand(deps, "add_transition"),
    setTransition: editorCommand(deps, "set_transition"),
    removeTransition: editorCommand(deps, "remove_transition"),
    addEffect: editorCommand(deps, "add_effect"),
    setEffect: editorCommand(deps, "set_effect"),
    getFx: editorCommand(deps, "get_fx"),
    groupClips: editorCommand(deps, "group_clips"),
    ungroup: editorCommand(deps, "ungroup"),
    createNull: editorCommand(deps, "create_null"),
    setClipParent: editorCommand(deps, "set_clip_parent"),
    applyEditPlan: (plan: unknown) =>
      deps.callEditor("commands.execute", { name: "apply_edit_plan", params: { plan } }, LONG_TIMEOUT_MS),

    /** This extension's own data on a clip, or null. Unwrapped, as above. */
    getElementData: async (elementId: string) => {
      const answer = (await deps.callEditor("commands.execute", {
        name: "ext_get_element_data",
        params: { elementId },
      })) as { value?: unknown } | null;
      return answer?.value ?? null;
    },
    setElementData: (elementId: string, value: unknown) =>
      deps.callEditor("commands.execute", { name: "ext_set_element_data", params: { elementId, value } }),

    onDidChange: (listener: (params: unknown) => void) => deps.onEvent("document.changed", listener),
  };

  const selection = {
    /**
     * The selected ids, as a plain array.
     *
     * Unwrapped here rather than handed over raw. `get_selection` answers
     * `{ ok, selected, clips }`, which is the shape a tool result wants and
     * not what an extension asking "what is selected" expects: the fixture
     * read `[0]` off that object, got `undefined`, and reported that nothing
     * was selected while a clip sat highlighted on screen. An API that
     * returns an internal command's envelope through a namespace promising
     * ids is a trap, and this is the only place to close it.
     */
    get: async () => {
      const answer = (await deps.callEditor(
        "commands.execute",
        { name: "get_selection", params: {} },
        SHORT_TIMEOUT_MS,
      )) as { selected?: unknown } | null;
      const selected = answer?.selected;
      return Array.isArray(selected) ? selected.filter((id): id is string => typeof id === "string") : [];
    },
    set: (elementIds: string[]) =>
      deps.callEditor("commands.execute", { name: "select_clips", params: { elementIds } }),
    onDidChange: (listener: (params: unknown) => void) => deps.onEvent("selection.changed", listener),
  };

  const playback = {
    setPlayhead: (atMs: number) =>
      deps.callEditor("commands.execute", { name: "set_playhead", params: { atMs } }, SHORT_TIMEOUT_MS),
    play: () => deps.callEditor("commands.execute", { name: "playback_play", params: {} }, SHORT_TIMEOUT_MS),
    pause: () => deps.callEditor("commands.execute", { name: "playback_pause", params: {} }, SHORT_TIMEOUT_MS),
    onDidChangePlayhead: (listener: (params: unknown) => void) => deps.onEvent("playhead.changed", listener),
    onDidChangeState: (listener: (params: unknown) => void) => deps.onEvent("playback.changed", listener),
  };

  const project = {
    info: () => deps.callEditor("project.info", {}, SHORT_TIMEOUT_MS),
    data: {
      get: async () => {
        const answer = (await deps.callEditor("project.getData", {}, SHORT_TIMEOUT_MS)) as
          | { value?: unknown }
          | null;
        return answer?.value ?? null;
      },
      set: (value: unknown) => deps.callEditor("project.setData", { value }, SHORT_TIMEOUT_MS),
    },
    onDidOpen: (listener: (params: unknown) => void) => deps.onEvent("project.opened", listener),
    onDidSave: (listener: (params: unknown) => void) => deps.onEvent("project.saved", listener),
  };

  const assets = {
    list: editorCommand(deps, "list_assets"),
    importPaths: (items: unknown) =>
      deps.callEditor("commands.execute", { name: "add_media", params: { items } }, LONG_TIMEOUT_MS),
    reveal: (target: string) => deps.callMain("assets.reveal", { path: target }),
  };

  const window = {
    showPanel: (viewId: string, placement?: unknown) =>
      deps.callEditor("window.showPanel", { viewId, placement }, SHORT_TIMEOUT_MS),
    closePanel: (viewId: string) => deps.callEditor("window.closePanel", { viewId }, SHORT_TIMEOUT_MS),
    showMessage: (text: string, kind: string = "info") =>
      deps.callEditor("window.showMessage", { text, kind }, SHORT_TIMEOUT_MS),
    setStatusItem: (item: unknown) => deps.callEditor("window.setStatusItem", item, SHORT_TIMEOUT_MS),

    showOpenDialog: async (options: Record<string, unknown> = {}) => {
      requirePermission(deps, "fs.read", "window.showOpenDialog");
      const picked = (await deps.callMain("window.showOpenDialog", options, LONG_TIMEOUT_MS)) as string[];
      // Picking a folder is the user granting access to it. Recording that
      // here is what lets `fs.readFile` accept the path they just chose
      // without the extension needing a permission that covers the whole disk.
      for (const entry of picked ?? []) {
        deps.grantDir(options.directory === true ? entry : path.dirname(entry));
      }
      return picked ?? [];
    },

    showSaveDialog: async (options: Record<string, unknown> = {}) => {
      requirePermission(deps, "fs.write", "window.showSaveDialog");
      const picked = (await deps.callMain("window.showSaveDialog", options, LONG_TIMEOUT_MS)) as string | null;
      if (typeof picked === "string") {
        deps.grantDir(path.dirname(picked));
      }
      return picked;
    },

    /**
     * A tray row with a cancel button, for anything that takes a while.
     *
     * The id is minted here rather than by the caller so that two overlapping
     * runs of the same command cannot collide on one row, which would leave a
     * spinner behind when the first finished.
     */
    withProgress: async (
      options: { title?: string; cancellable?: boolean },
      task: (progress: { report(fraction: number | null, stage?: string): void }, signal: AbortSignal) => Promise<unknown>,
    ) => {
      const taskId = deps.extId + ":" + Math.random().toString(36).slice(2, 10);
      const controller = new AbortController();
      const cancelled = deps.onEvent("task.cancelled:" + taskId, () => controller.abort());
      await deps.callEditor(
        "task.start",
        { taskId, label: options.title ?? deps.manifest.displayName, cancellable: options.cancellable === true },
        SHORT_TIMEOUT_MS,
      );
      try {
        return await task(
          {
            report: (fraction, stage) => {
              void deps.callEditor("task.progress", { taskId, fraction, stage }, SHORT_TIMEOUT_MS).catch(() => null);
            },
          },
          controller.signal,
        );
      } finally {
        cancelled.dispose();
        // In `finally` so a task that throws still clears its row. A tray row
        // that outlives its work is one the user can only remove by quitting.
        await deps.callEditor("task.end", { taskId }, SHORT_TIMEOUT_MS).catch(() => null);
      }
    },
  };

  const ui = {
    onViewMessage: (viewId: string, listener: (message: unknown) => void) =>
      deps.onViewMessage(viewId, listener),
    postMessageToView: (viewId: string, message: unknown) =>
      deps.callMain("view.post", { viewId, message }, SHORT_TIMEOUT_MS),
  };

  const fs = {
    readFile: async (target: string) => {
      requirePermission(deps, "fs.read", "fs.readFile");
      return fsp.readFile(assertAllowedPath(deps, target, false));
    },
    readText: async (target: string) => {
      requirePermission(deps, "fs.read", "fs.readText");
      return fsp.readFile(assertAllowedPath(deps, target, false), "utf8");
    },
    readdir: async (target: string) => {
      requirePermission(deps, "fs.read", "fs.readdir");
      return fsp.readdir(assertAllowedPath(deps, target, false));
    },
    stat: async (target: string) => {
      requirePermission(deps, "fs.read", "fs.stat");
      const info = await fsp.stat(assertAllowedPath(deps, target, false));
      return { size: info.size, isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs };
    },
    writeFile: async (target: string, data: Uint8Array | string) => {
      requirePermission(deps, "fs.write", "fs.writeFile");
      const resolved = assertAllowedPath(deps, target, true);
      await fsp.mkdir(path.dirname(resolved), { recursive: true });
      await fsp.writeFile(resolved, data as never);
    },
    mkdir: async (target: string) => {
      requirePermission(deps, "fs.write", "fs.mkdir");
      await fsp.mkdir(assertAllowedPath(deps, target, true), { recursive: true });
    },
    storageDir: () => deps.dataDir,
  };

  const processApi = {
    ffmpegPath: () => {
      requirePermission(deps, "process.spawn", "process.ffmpegPath");
      return deps.callMain("paths.ffmpeg", {}, SHORT_TIMEOUT_MS);
    },
    ffprobePath: () => {
      requirePermission(deps, "process.spawn", "process.ffprobePath");
      return deps.callMain("paths.ffprobe", {}, SHORT_TIMEOUT_MS);
    },
    spawn: (
      command: string,
      args: string[] = [],
      options: { cwd?: string; signal?: AbortSignal; onStdout?: (s: string) => void; onStderr?: (s: string) => void } = {},
    ) => {
      requirePermission(deps, "process.spawn", "process.spawn");
      return new Promise<{ code: number | null }>((resolve, reject) => {
        const child = spawn(command, args, { cwd: options.cwd });
        options.signal?.addEventListener("abort", () => child.kill());
        child.stdout?.on("data", (chunk) => options.onStdout?.(String(chunk)));
        child.stderr?.on("data", (chunk) => options.onStderr?.(String(chunk)));
        child.once("error", reject);
        child.once("close", (code) => resolve({ code }));
      });
    },
  };

  const net = {
    fetch: (input: string, init?: unknown) => {
      requirePermission(deps, "net", "net.fetch");
      return (globalThis as { fetch: (i: string, n?: unknown) => Promise<unknown> }).fetch(input, init);
    },
  };

  const config = {
    get: (key?: string) => deps.callMain("config.get", { key }, SHORT_TIMEOUT_MS),
    set: (key: string, value: unknown) => deps.callMain("config.set", { key, value }, SHORT_TIMEOUT_MS),
    onDidChange: (listener: (params: unknown) => void) => deps.onEvent("config.changed", listener),
  };

  const storage = {
    get: (key: string) => deps.callMain("storage.get", { key }, SHORT_TIMEOUT_MS),
    set: (key: string, value: unknown) => deps.callMain("storage.set", { key, value }, SHORT_TIMEOUT_MS),
    delete: (key: string) => deps.callMain("storage.delete", { key }, SHORT_TIMEOUT_MS),
  };

  const secrets = {
    get: (key: string) => deps.callMain("secrets.get", { key }, SHORT_TIMEOUT_MS),
    set: (key: string, value: string) => deps.callMain("secrets.set", { key, value }, SHORT_TIMEOUT_MS),
    delete: (key: string) => deps.callMain("secrets.delete", { key }, SHORT_TIMEOUT_MS),
  };

  const ai = {
    registerTool: (tool: { name: string; description: string; inputSchema?: unknown; handler: ToolHandler }) =>
      deps.registerTool(tool.name, tool.description, tool.inputSchema, tool.handler),
  };

  const exportsApi = {
    onWillExport: (listener: (event: unknown) => unknown) => deps.onExportWill(listener),
    onDidExport: (listener: (event: unknown) => void) => deps.onExportDid(listener),
  };

  const shell = {
    open: (target: string) => deps.callMain("shell.open", { target }, SHORT_TIMEOUT_MS),
  };

  const clipboardApi = {
    read: () => deps.callMain("clipboard.read", {}, SHORT_TIMEOUT_MS),
    write: (text: string) => deps.callMain("clipboard.write", { text }, SHORT_TIMEOUT_MS),
  };

  return {
    commands,
    timeline,
    selection,
    playback,
    project,
    assets,
    window,
    ui,
    fs,
    process: processApi,
    net,
    config,
    storage,
    secrets,
    ai,
    exports: exportsApi,
    shell,
    clipboard: clipboardApi,
  };
}
