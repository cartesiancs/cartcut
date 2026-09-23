/**
 * The extension host as an application: one child process, two ports, and the
 * policy for what happens when it dies.
 *
 * Forked as a `utilityProcess`, which is the shape `lib/tts/tts.ts` arrived at
 * and for the third of its three reasons above all: **a fault in the child
 * takes down only the child.** An extension is a stranger's code running in
 * the same app as an unsaved timeline, and the whole design rests on there
 * being no way for it to reach that timeline except by asking.
 *
 * ## Two ports, and they are not the same port
 *
 * `R` runs host to editor renderer, directly. Every edit, every read, every
 * event travels on it, and main is not in the path: a host that wedges cannot
 * block the process that owns the menu, the windows and the dialogs.
 *
 * `M` runs host to main, and carries only what main alone can do. It is a
 * separate port rather than a namespace on the first one so that the answer to
 * "can the host make main do this?" is a list in `services.ts` rather than a
 * property of a message field.
 *
 * ## The renderer's port is re-minted, never reused
 *
 * A `MessagePort` belongs to the context it was delivered to, and a reloaded
 * page has lost the one it had. So every `did-finish-load` mints a fresh pair:
 * one end to the page, one end to the host, which swaps its `R` endpoint.
 * Without this, a renderer reload would leave the host holding a port whose
 * other end is in a dead frame and no error anywhere.
 */

import * as fsp from "fs/promises";
import path from "path";
import {
  MessageChannelMain,
  app,
  utilityProcess,
  type BrowserWindow,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents,
} from "electron";

import { createLogRing, formatLogArgs, type LogLevel, type LogLine } from "./hostLog";
import { createRpcEndpoint, type PortLike, type RpcEndpoint } from "./rpc";
import { createServiceHandlers, type ContributedTool } from "./services";
import { extensionsRoot, isValidExtensionId } from "./dirs";
import { readStoredConfig, resolveConfig, type ConfigSchema } from "./config";
import { scanExtensionRoots, type Discovered, type FsPorts } from "./discovery";
import {
  initialHostSession,
  reduceHost,
  type HostEvent,
  type HostSession,
} from "./session";
import { disabledIds, isEnabled, unpackedPaths } from "./settings";
import { LONG_TIMEOUT_MS, SHORT_TIMEOUT_MS } from "./protocol";

const realFs: FsPorts = {
  readdir: (dir) => fsp.readdir(dir),
  readFile: (file) => fsp.readFile(file, "utf8"),
  isDirectory: async (target) => {
    try {
      return (await fsp.stat(target)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** How long `deactivate()` gets before the process is killed at quit. */
const SHUTDOWN_GRACE_MS = 2_000;

type HostRuntime = {
  child: UtilityProcess;
  main: RpcEndpoint;
  mainPort: MessagePortMain;
};

let session: HostSession = initialHostSession();
let runtime: HostRuntime | null = null;
let target: WebContents | null = null;
let discovered: Discovered[] = [];
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let quitting = false;

const logs = createLogRing();
/** Per-extension phase as the host last reported it, for the panel. */
const phases = new Map<string, { phase: string; error: string | null }>();
/** Tools an extension registered at runtime, keyed by extension then name. */
const tools = new Map<string, Map<string, ContributedTool>>();
/** Menu items an extension contributed, keyed by extension. */
const menus = new Map<string, unknown>();

type HostListener = (session: HostSession) => void;
const listeners = new Set<HostListener>();

export function onHostSessionChange(listener: HostListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hostSession(): HostSession {
  return session;
}

function dispatch(event: HostEvent): void {
  const next = reduceHost(session, event);
  if (next === session) {
    return;
  }
  session = next;
  publishState();
  for (const listener of listeners) {
    listener(session);
  }

  if (session.state === "restarting" && !quitting) {
    scheduleFork(session.restartDelayMs);
  }
}

function publishState(): void {
  if (target == null || target.isDestroyed()) {
    return;
  }
  target.send("ext:host:state", {
    state: session.state,
    crashes: session.crashes.length,
    lastError: session.lastError,
  });
}

function adaptPort(port: MessagePortMain): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (handler) => port.on("message", (event) => handler(event.data)),
    onClose: (handler) => port.on("close", handler),
    start: () => port.start(),
    close: () => port.close(),
  };
}

function manifestOf(id: string) {
  return discovered.find((entry) => entry.id === id)?.manifest ?? null;
}

let menuChanged: (() => void) | null = null;

/** Set by `main.ts` so a contributed menu can reach `installMenu` without a cycle. */
export function onExtensionMenusChanged(handler: () => void): void {
  menuChanged = handler;
}

let dialogWindow: (() => BrowserWindow | null) | null = null;

export function setExtensionDialogParent(getter: () => BrowserWindow | null): void {
  dialogWindow = getter;
}

function serviceContext() {
  return {
    manifestOf,
    log: (id: string, level: LogLevel, text: string) => {
      logs.push(id, level, text);
    },
    onHostReady: () => {
      dispatch({ type: "ready", at: Date.now() });
    },
    onExtensionState: (id: string, phase: string, error: string | null) => {
      phases.set(id, { phase, error });
      if (target != null && !target.isDestroyed()) {
        target.send("ext:extension:state", { id, phase, error });
      }
    },
    postToView: (extId: string, viewId: string, message: unknown) => {
      postToExtensionView(extId, viewId, message);
    },
    setMenus: (extId: string, items: unknown) => {
      menus.set(extId, items);
      menuChanged?.();
    },
    registerTool: (extId: string, tool: ContributedTool) => {
      const own = tools.get(extId) ?? new Map<string, ContributedTool>();
      own.set(tool.name, tool);
      tools.set(extId, own);
      toolsChanged?.();
    },
    unregisterTool: (extId: string, name: string) => {
      tools.get(extId)?.delete(name);
      toolsChanged?.();
    },
    dialogParent: () => dialogWindow?.() ?? null,
  };
}

let toolsChanged: (() => void) | null = null;

/** Set by the MCP server so a newly registered tool can be announced. */
export function onExtensionToolsChanged(handler: () => void): void {
  toolsChanged = handler;
}

/** Every runtime tool, flattened, for `mcpTools.ts`. */
export function extensionTools(): Array<{ extId: string; tool: ContributedTool }> {
  const flat: Array<{ extId: string; tool: ContributedTool }> = [];
  for (const [extId, own] of tools) {
    for (const tool of own.values()) {
      flat.push({ extId, tool });
    }
  }
  return flat;
}

/** Menu items every enabled extension contributed, for `menu.ts`. */
export function extensionMenus(): Array<{ extId: string; items: unknown }> {
  return [...menus].map(([extId, items]) => ({ extId, items }));
}

function entryPoint(): string {
  // Compiled JavaScript beside this file inside the asar, exactly as
  // `tts.ts#workerEntry` resolves its worker. No `process.resourcesPath`: this
  // is our own output, not an extra resource copied in beside the app.
  return path.join(__dirname, "hostMain.js");
}

function scheduleFork(delayMs: number): void {
  if (restartTimer != null) {
    clearTimeout(restartTimer);
  }
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void forkHost();
  }, delayMs);
}

async function collectExtensions(): Promise<Discovered[]> {
  const found = await scanExtensionRoots(extensionsRoot(), unpackedPaths(), realFs);
  const disabled = new Set(disabledIds());
  return found.map((entry) => ({
    ...entry,
    // A disabled extension is still discovered and still listed, so the panel
    // can offer to switch it back on. It simply never reaches the host with a
    // manifest, which is what the host loads from.
    manifest: disabled.has(entry.id) ? null : entry.manifest,
  }));
}

/** What the host is told about one extension. Plain data across the clone. */
function payloadFor(entry: Discovered) {
  return {
    id: entry.id,
    dir: entry.dir,
    origin: entry.origin,
    manifest: entry.manifest,
    enabled: isEnabled(entry.id),
  };
}

async function forkHost(): Promise<void> {
  if (quitting) {
    return;
  }
  teardownRuntime();

  discovered = await collectExtensions();

  const configs: Record<string, Record<string, string | number | boolean>> = {};
  for (const entry of discovered) {
    if (entry.manifest == null) {
      continue;
    }
    const schema = (entry.manifest.contributes.configuration?.properties ?? {}) as ConfigSchema;
    configs[entry.id] = resolveConfig(schema, await readStoredConfig(entry.id));
  }

  dispatch({ type: "fork", at: Date.now() });

  const child = utilityProcess.fork(entryPoint(), [], {
    // Named so it is identifiable in Activity Monitor rather than showing up
    // as a second anonymous helper nobody can account for.
    serviceName: "cartcut-extension-host",
    // Piped rather than inherited so an extension's `console.log` reaches the
    // Extensions panel instead of a terminal the user does not have open.
    stdio: "pipe",
  });

  const toMain = new MessageChannelMain();
  const mainEndpoint = createRpcEndpoint(adaptPort(toMain.port1), {
    request: createServiceHandlers(serviceContext()),
  });

  runtime = { child, main: mainEndpoint, mainPort: toMain.port1 };

  child.postMessage(
    {
      type: "init",
      extensions: discovered.map(payloadFor),
      configs,
      // The host builds every storage path from this rather than asking main
      // per call, and main is still the only process that decided what it is.
      dataRoot: path.join(app.getPath("userData"), "extension-data"),
    },
    [toMain.port2],
  );

  pipeOutput(child);

  child.once("exit", (code) => {
    if (runtime?.child !== child) {
      return;
    }
    teardownRuntime();
    dispatch({ type: "exit", at: Date.now(), code });
  });

  // The page may already be loaded, in which case nothing else will fire.
  sendRendererPort();
}

function pipeOutput(child: UtilityProcess): void {
  const read = (stream: NodeJS.ReadableStream | null, level: LogLevel) => {
    if (stream == null) {
      return;
    }
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      // A pipe splits wherever it likes, including mid-line and mid-character.
      // Without the buffer a long stack trace arrives as three log entries
      // that each look like a different error.
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") {
          logs.push("host", level, line);
        }
      }
    });
  };
  read(child.stdout, "info");
  read(child.stderr, "error");
}

function teardownRuntime(): void {
  const current = runtime;
  runtime = null;
  if (current == null) {
    return;
  }
  current.main.dispose("extension host stopped");
  try {
    current.child.kill();
  } catch {
    // Already gone. `kill` on a reaped process throws on some platforms and
    // there is nothing to do about it.
  }
}

/**
 * Give the editor and the host a fresh pair of connected ports.
 *
 * Called on every load of the editor page, and once when the host forks in
 * case the page is already up. Minting a new pair rather than reusing one is
 * what makes a renderer reload survivable: the old pair's renderer end went
 * away with the old page, and a host still holding its half would post into
 * nothing forever.
 *
 * ## The generation is not decoration
 *
 * The two ends are reached over different channels, so nothing orders a fork
 * and a page load against each other. Sent without a generation, a first
 * launch really does deliver two pairs, and the host and the renderer each
 * keep whichever arrived last: about half the time that is not the same pair,
 * and the result is a host and an editor each holding one end of two
 * different channels, with a completed handshake and no way to call anybody.
 *
 * Measured, not theorised: that is exactly what the fixture extension did on
 * the first run of this code. So each pair carries a number, both ends ignore
 * anything older than what they hold, and they converge on the highest.
 *
 * The counter **never resets**, including across a fork. Restarting it for a
 * new host looks tidy and is wrong: the renderer holds the number from the
 * host that just died, so every port the replacement sends looks older and is
 * ignored, and the extension system comes back with the host running and the
 * editor unable to reach it. That is what happened the first time this reset.
 */
let portGeneration = 0;

function sendRendererPort(): void {
  const current = runtime;
  if (current == null || target == null || target.isDestroyed()) {
    return;
  }
  portGeneration += 1;
  const generation = portGeneration;
  const channel = new MessageChannelMain();
  current.child.postMessage({ type: "renderer-port", generation }, [channel.port1]);
  target.postMessage("ext:port", { generation }, [channel.port2]);
}

/**
 * Point the host at a window, and keep it pointed there across reloads.
 *
 * Idempotent per `webContents`: `main.ts` calls this from window creation,
 * which happens again on macOS `activate`.
 */
export function attachExtensionHost(webContents: WebContents): void {
  target = webContents;

  webContents.on("did-finish-load", () => {
    if (target !== webContents) {
      return;
    }
    publishState();
    sendRendererPort();
  });

  webContents.once("destroyed", () => {
    if (target === webContents) {
      target = null;
    }
  });
}

export function startExtensionHost(): void {
  if (runtime != null || session.state === "starting") {
    return;
  }
  void forkHost();
}

export function restartExtensionHost(): void {
  dispatch({ type: "restart", at: Date.now() });
}

/** A file under an unpacked path changed. Not a crash, so no backoff. */
export function reloadExtensionHost(): void {
  dispatch({ type: "reload", at: Date.now() });
}

export async function stopExtensionHost(): Promise<void> {
  quitting = true;
  if (restartTimer != null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const current = runtime;
  dispatch({ type: "stop", at: Date.now() });
  if (current == null) {
    return;
  }

  // Ask first, kill second. An extension's `deactivate` is where it flushes
  // whatever it was holding, and killing without asking would lose that on
  // every quit. The grace period is short because a quit that waits on a
  // stranger's promise is a quit that hangs.
  await Promise.race([
    current.main.request("host.shutdown", {}, { timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
  ]);
  teardownRuntime();
}

/** Whether a request could be answered right now. */
export function isHostReady(): boolean {
  return runtime != null && session.state === "ready";
}

function requireRuntime(): HostRuntime {
  if (runtime == null || session.state !== "ready") {
    throw new Error(
      "The extension host is not running" + (session.lastError == null ? "" : ": " + session.lastError),
    );
  }
  return runtime;
}

/** Run one contributed tool. Called by the MCP tool layer. */
export function invokeExtensionTool(extId: string, name: string, args: unknown): Promise<unknown> {
  return requireRuntime().main.request(
    "ai.invoke",
    { ext: extId, name, args },
    { timeoutMs: LONG_TIMEOUT_MS },
  );
}

/** A webview page sent its extension a message. */
export function forwardViewMessage(extId: string, viewId: string, message: unknown): void {
  if (runtime == null) {
    return;
  }
  runtime.main.emit("view.message", { ext: extId, viewId, message });
}

export function forwardViewVisibility(extId: string, viewId: string, visible: boolean): void {
  runtime?.main.emit("view.visible", { ext: extId, viewId, visible });
}

/** Set by `viewBridge.ts`, which owns the map from view id to a webContents. */
let viewPoster: ((extId: string, viewId: string, message: unknown) => void) | null = null;

export function setExtensionViewPoster(
  poster: (extId: string, viewId: string, message: unknown) => void,
): void {
  viewPoster = poster;
}

function postToExtensionView(extId: string, viewId: string, message: unknown): void {
  viewPoster?.(extId, viewId, message);
}

/** Told the host that an extension was switched on or off, without a restart. */
export function setExtensionEnabled(id: string, enabled: boolean): void {
  runtime?.main.emit("host.setEnabled", { ext: id, enabled });
}

export function notifyConfigChanged(id: string, values: Record<string, unknown>): void {
  runtime?.main.emit("config.changed", { ext: id, values });
}

export type ExtensionListing = {
  id: string;
  dir: string;
  origin: "installed" | "unpacked";
  displayName: string;
  version: string;
  description: string;
  permissions: string[];
  enabled: boolean;
  phase: string;
  errors: string[];
  configuration: unknown;
  /** `contributes.presets`, relative and unchecked. `preset.ts` resolves it. */
  presetsFolder: string | null;
  /** `contributes.templates`, same shape. */
  templatesFolder: string | null;
  /** `contributes.animationPresets`, same shape. */
  animationPresetsFolder: string | null;
};

/** What the Extensions panel shows. Rebuilt from what main knows, not the host. */
export function listExtensions(): ExtensionListing[] {
  return discovered.map((entry) => {
    const reported = phases.get(entry.id);
    return {
      id: entry.id,
      dir: entry.dir,
      origin: entry.origin,
      displayName: entry.manifest?.displayName ?? entry.id,
      version: entry.manifest?.version ?? "",
      description: entry.manifest?.description ?? "",
      permissions: entry.manifest?.permissions ?? [],
      enabled: isEnabled(entry.id),
      phase: reported?.phase ?? (entry.errors.length > 0 ? "failed" : "discovered"),
      errors: [...entry.errors, ...(reported?.error == null ? [] : [reported.error])],
      configuration: entry.manifest?.contributes.configuration ?? null,
      presetsFolder: entry.manifest?.contributes.presets ?? null,
      templatesFolder: entry.manifest?.contributes.templates ?? null,
      animationPresetsFolder: entry.manifest?.contributes.animationPresets ?? null,
    };
  });
}

export function extensionLog(id: string): LogLine[] {
  return isValidExtensionId(id) || id === "host" ? logs.lines(id) : [];
}

export function appendHostLog(id: string, level: LogLevel, args: readonly unknown[]): void {
  logs.push(id, level, formatLogArgs(args));
}

/** Refreshes what main knows about the folders, without forking. */
export async function rescanExtensions(): Promise<ExtensionListing[]> {
  discovered = await collectExtensions();
  return listExtensions();
}

app.on("will-quit", () => {
  quitting = true;
});
