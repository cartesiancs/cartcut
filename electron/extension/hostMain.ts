/**
 * The extension host, from the inside.
 *
 * Runs as a `utilityProcess`: a Node environment with the app's `node_modules`
 * on its path, and with no DOM, no store, no `electronAPI` and no way to reach
 * the editor except the port it is handed. That absence is the design. Every
 * protection the app has against a badly behaved extension is a consequence of
 * this file running somewhere else, not of anything it does.
 *
 * What it owns: loading each extension's entry point, handing it its `cartcut`
 * object, running `activate` when something asks for it, and routing inbound
 * calls to whichever extension registered the thing being called.
 *
 * Nothing here is allowed to throw at the top level. An extension that fails to
 * load, fails to activate, or throws inside a command must cost only itself:
 * the host stays up and the other extensions keep working, which is the same
 * promise `presetRegistry.ts` makes about one bad preset folder.
 */

import path from "path";
import { pathToFileURL } from "url";

import { createExtensionApi, type Disposable } from "./api";
import { createRpcEndpoint, RpcError, type PortLike, type RpcEndpoint } from "./rpc";
import {
  initialExtension,
  matchesActivation,
  reduceExtension,
  type ActivationTrigger,
  type ExtensionRecord,
} from "./extensionState";
import {
  DEFAULT_TIMEOUT_MS,
  EXTENSION_API_VERSION,
  LONG_TIMEOUT_MS,
  PROTOCOL_VERSION,
} from "./protocol";
import type { ExtensionManifest } from "./manifest";

type InitPayload = {
  id: string;
  dir: string;
  origin: "installed" | "unpacked";
  manifest: ExtensionManifest | null;
  enabled: boolean;
};

type ParentPortLike = {
  postMessage(value: unknown): void;
  on(event: "message", handler: (message: { data: unknown; ports: unknown[] }) => void): void;
};

const parentPort = (process as unknown as { parentPort: ParentPortLike }).parentPort;

/**
 * `import()` that survives compilation to CommonJS.
 *
 * `tsc` rewrites a literal `await import(x)` into a `require`, which cannot
 * load an ES module. Building the function at run time hides it from the
 * compiler, which is the only way one build can load both kinds of entry
 * point.
 */
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

type Loaded = {
  payload: InitPayload;
  manifest: ExtensionManifest;
  record: ExtensionRecord;
  module: Record<string, unknown> | null;
  api: Record<string, unknown>;
  subscriptions: Disposable[];
  commands: Map<string, (args?: unknown, signal?: AbortSignal) => unknown>;
  tools: Map<string, (args: unknown, signal: AbortSignal) => Promise<unknown>>;
  events: Map<string, Set<(params: unknown) => void>>;
  viewListeners: Map<string, Set<(message: unknown) => void>>;
  exportWill: Set<(event: unknown) => unknown>;
  exportDid: Set<(event: unknown) => void>;
  grantedDirs: Set<string>;
  /** Resolves when activation finishes, so a second trigger queues rather than races. */
  activation: Promise<void> | null;
};

const extensions = new Map<string, Loaded>();
let mainEndpoint: RpcEndpoint | null = null;
let editorEndpoint: RpcEndpoint | null = null;
let editorReady = false;
let projectDir: string | null = null;
let configs: Record<string, Record<string, string | number | boolean>> = {};

function adaptPort(port: unknown): PortLike {
  const typed = port as {
    postMessage(value: unknown): void;
    on(event: string, handler: (event: { data: unknown }) => void): void;
    start(): void;
    close(): void;
  };
  return {
    postMessage: (message) => typed.postMessage(message),
    onMessage: (handler) => typed.on("message", (event) => handler(event.data)),
    onClose: (handler) => typed.on("close", handler as never),
    start: () => typed.start(),
    close: () => typed.close(),
  };
}

function log(extId: string, level: "info" | "warn" | "error", args: unknown[]): void {
  const text = args
    .map((value) => {
      if (typeof value === "string") {
        return value;
      }
      if (value instanceof Error) {
        return value.stack ?? value.message;
      }
      try {
        return JSON.stringify(value) ?? String(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    })
    .join(" ");
  // Sent as a request but never awaited: main answers it so the call has a
  // shape, and a log line that could reject the caller would be a log line
  // that changes behaviour.
  void mainEndpoint?.request("host.log", { ext: extId, level, text }).catch(() => null);
}

function reportState(loaded: Loaded): void {
  void mainEndpoint
    ?.request("host.extensionState", {
      ext: loaded.payload.id,
      phase: loaded.record.phase,
      error: loaded.record.error,
    })
    .catch(() => null);
}

function setPhase(loaded: Loaded, event: Parameters<typeof reduceExtension>[1]): void {
  const next = reduceExtension(loaded.record, event);
  if (next === loaded.record) {
    return;
  }
  loaded.record = next;
  reportState(loaded);
}

function disposableOf(remove: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) {
        return;
      }
      done = true;
      remove();
    },
  };
}

function buildApi(loaded: Loaded): Record<string, unknown> {
  const extId = loaded.payload.id;

  return createExtensionApi({
    extId,
    manifest: loaded.manifest,
    dir: loaded.payload.dir,
    dataDir: dataDirFor(extId),
    callEditor: (method, params, timeoutMs) => {
      if (editorEndpoint == null) {
        return Promise.reject(new RpcError("E_INTERNAL", "the editor is not connected yet"));
      }
      return editorEndpoint.request(method, params, { ext: extId, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS });
    },
    callMain: (method, params, timeoutMs) => {
      if (mainEndpoint == null) {
        return Promise.reject(new RpcError("E_INTERNAL", "the host is not connected to the app"));
      }
      return mainEndpoint.request(method, params, { ext: extId, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS });
    },
    log: (level, args) => log(extId, level, args),
    registerCommand: (id, handler) => {
      loaded.commands.set(id, handler);
      return disposableOf(() => loaded.commands.delete(id));
    },
    registerTool: (name, description, inputSchema, handler) => {
      loaded.tools.set(name, handler);
      void mainEndpoint
        ?.request("ai.registerTool", { name, description, inputSchema }, { ext: extId })
        .catch((error) => log(extId, "error", ["could not register tool " + name, error]));
      return disposableOf(() => {
        loaded.tools.delete(name);
        void mainEndpoint?.request("ai.unregisterTool", { name }, { ext: extId }).catch(() => null);
      });
    },
    onEvent: (name, listener) => {
      const set = loaded.events.get(name) ?? new Set();
      set.add(listener);
      loaded.events.set(name, set);
      return disposableOf(() => set.delete(listener));
    },
    onViewMessage: (viewId, listener) => {
      const set = loaded.viewListeners.get(viewId) ?? new Set();
      set.add(listener);
      loaded.viewListeners.set(viewId, set);
      return disposableOf(() => set.delete(listener));
    },
    onExportWill: (listener) => {
      loaded.exportWill.add(listener);
      return disposableOf(() => loaded.exportWill.delete(listener));
    },
    onExportDid: (listener) => {
      loaded.exportDid.add(listener);
      return disposableOf(() => loaded.exportDid.delete(listener));
    },
    projectDir: () => projectDir,
    grantedDirs: () => [...loaded.grantedDirs],
    grantDir: (dir) => loaded.grantedDirs.add(dir),
  });
}

/** Mirrors `dirs.ts#extensionDataDir`, which main cannot be asked for per call. */
let dataRoot = "";
function dataDirFor(extId: string): string {
  return path.join(dataRoot, extId);
}

/**
 * `require("cartcut")` resolves to the calling extension's own API object.
 *
 * Keyed on the requiring file's directory, which is how VSCode does it and the
 * only thing that works: one host process holds every extension, so a single
 * shared module would hand each of them the same object and every permission
 * check would be made against whichever manifest loaded last.
 */
function installRequireHook(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require("module") as {
    _load(request: string, parent: { filename?: string } | null, isMain: boolean): unknown;
  };
  const original = Module._load;
  Module._load = function patched(
    this: unknown,
    request: string,
    parent: { filename?: string } | null,
    isMain: boolean,
  ) {
    if (request === "cartcut") {
      const from = parent?.filename;
      if (typeof from === "string") {
        for (const loaded of extensions.values()) {
          const dir = path.resolve(loaded.payload.dir);
          if (path.resolve(from).startsWith(dir + path.sep)) {
            return loaded.api;
          }
        }
      }
      throw new Error(
        'require("cartcut") is only available inside an extension. This file is not under any loaded extension folder.',
      );
    }
    return original.call(this, request, parent, isMain);
  } as typeof Module._load;
}

function loadPayload(payload: InitPayload): void {
  if (payload.manifest == null || !payload.enabled) {
    return;
  }
  const loaded: Loaded = {
    payload,
    manifest: payload.manifest,
    record: initialExtension(payload.id, payload.enabled),
    module: null,
    api: {},
    subscriptions: [],
    commands: new Map(),
    tools: new Map(),
    events: new Map(),
    viewListeners: new Map(),
    exportWill: new Set(),
    exportDid: new Set(),
    grantedDirs: new Set(),
    activation: null,
  };
  loaded.api = buildApi(loaded);
  extensions.set(payload.id, loaded);
  setPhase(loaded, { type: "validated" });
}

async function activate(loaded: Loaded, trigger: string): Promise<void> {
  if (loaded.record.phase === "active") {
    return;
  }
  if (loaded.activation != null) {
    // A second trigger while the first activation is still running waits for
    // it instead of starting a second `activate()`. Two concurrent activations
    // would register every command twice and dispose each other's handles.
    return loaded.activation;
  }

  setPhase(loaded, { type: "activate", trigger });
  if (loaded.record.phase !== "activating") {
    return;
  }

  const run = (async () => {
    const extId = loaded.payload.id;
    const entry = path.join(loaded.payload.dir, loaded.manifest.main);
    try {
      const isEsm = entry.endsWith(".mjs");
      loaded.module = isEsm
        ? await dynamicImport(pathToFileURL(entry).href)
        : // eslint-disable-next-line @typescript-eslint/no-var-requires
          (require(entry) as Record<string, unknown>);

      const activateFn = loaded.module?.activate;
      if (typeof activateFn === "function") {
        await (activateFn as (ctx: unknown) => unknown)({
          extensionId: extId,
          extensionPath: loaded.payload.dir,
          subscriptions: loaded.subscriptions,
          globalStorageUri: dataDirFor(extId),
          config: configs[extId] ?? {},
          // An ESM entry cannot `require("cartcut")`, so it is handed the same
          // object here. Both routes give the identical instance, so a mixed
          // codebase cannot end up with two.
          cartcut: loaded.api,
          log: {
            info: (...args: unknown[]) => log(extId, "info", args),
            warn: (...args: unknown[]) => log(extId, "warn", args),
            error: (...args: unknown[]) => log(extId, "error", args),
          },
        });
      }
      setPhase(loaded, { type: "activated" });
      log(extId, "info", ["activated by " + trigger]);
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      setPhase(loaded, { type: "activationFailed", error: message });
      log(extId, "error", ["activation failed", message]);
    } finally {
      loaded.activation = null;
    }
  })();

  loaded.activation = run;
  return run;
}

async function deactivate(loaded: Loaded): Promise<void> {
  if (loaded.record.phase !== "active" && loaded.record.phase !== "activating") {
    return;
  }
  setPhase(loaded, { type: "deactivate" });

  // Reverse order, so a subscription that depends on an earlier one is torn
  // down while that one is still valid.
  for (const subscription of [...loaded.subscriptions].reverse()) {
    try {
      subscription.dispose();
    } catch (error) {
      log(loaded.payload.id, "error", ["a subscription threw while disposing", error]);
    }
  }
  loaded.subscriptions.length = 0;
  loaded.commands.clear();
  loaded.tools.clear();
  loaded.events.clear();
  loaded.viewListeners.clear();
  loaded.exportWill.clear();
  loaded.exportDid.clear();

  const deactivateFn = loaded.module?.deactivate;
  if (typeof deactivateFn === "function") {
    try {
      await Promise.race([
        (deactivateFn as () => unknown)(),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch (error) {
      log(loaded.payload.id, "error", ["deactivate threw", error]);
    }
  }

  setPhase(loaded, { type: "deactivated" });
}

function trigger(kind: ActivationTrigger): Promise<void[]> {
  const waiting: Array<Promise<void>> = [];
  for (const loaded of extensions.values()) {
    if (matchesActivation(loaded.manifest.activationEvents, kind)) {
      waiting.push(activate(loaded, activationNameOf(kind)));
    }
  }
  return Promise.all(waiting);
}

function activationNameOf(kind: ActivationTrigger): string {
  switch (kind.kind) {
    case "startup":
      return "onStartup";
    case "projectOpen":
      return "onProjectOpen";
    case "command":
      return "onCommand:" + kind.id;
    case "view":
      return "onView:" + kind.id;
    case "filetype":
      return "onFiletype:" + kind.ext;
  }
}

function helloPayload() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    apiVersion: EXTENSION_API_VERSION,
    extensions: [...extensions.values()].map((loaded) => ({
      id: loaded.payload.id,
      version: loaded.manifest.version,
      displayName: loaded.manifest.displayName,
      permissions: loaded.manifest.permissions,
      contributes: loaded.manifest.contributes,
    })),
  };
}

async function handleEditorRequest(request: {
  method: string;
  params: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  const args = (request.params ?? {}) as Record<string, unknown>;

  switch (request.method) {
    case "commands.invoke": {
      const extId = String(args.extId ?? "");
      const commandId = String(args.command ?? "");
      const loaded = extensions.get(extId);
      if (loaded == null) {
        throw new RpcError("E_UNKNOWN_METHOD", "`" + extId + "` is not loaded");
      }
      // A command can be invoked before its extension has been activated: the
      // activation event is what the click *is*. Activating first, then
      // dispatching, is why `onCommand:` exists at all.
      await activate(loaded, "onCommand:" + commandId);
      const handler = loaded.commands.get(commandId);
      if (handler == null) {
        throw new RpcError(
          "E_UNKNOWN_METHOD",
          "`" + extId + "` did not register a command called `" + commandId + "`",
        );
      }
      return (await handler(args.args, request.signal)) ?? null;
    }

    case "activation.request": {
      const kind = args.trigger as ActivationTrigger | undefined;
      if (kind != null) {
        await trigger(kind);
      }
      return null;
    }

    case "export.willExport": {
      const answers: unknown[] = [];
      for (const loaded of extensions.values()) {
        for (const listener of loaded.exportWill) {
          try {
            answers.push(await listener(args));
          } catch (error) {
            log(loaded.payload.id, "error", ["onWillExport threw", error]);
          }
        }
      }
      return answers;
    }

    case "export.didExport": {
      for (const loaded of extensions.values()) {
        for (const listener of loaded.exportDid) {
          try {
            listener(args);
          } catch (error) {
            log(loaded.payload.id, "error", ["onDidExport threw", error]);
          }
        }
      }
      return null;
    }

    default:
      throw new RpcError("E_UNKNOWN_METHOD", "the extension host does not answer `" + request.method + "`");
  }
}

function handleEditorEvent(event: { event: string; params: unknown }): void {
  if (event.event === "project.opened") {
    const params = (event.params ?? {}) as { dir?: string };
    projectDir = typeof params.dir === "string" ? params.dir : null;
    void trigger({ kind: "projectOpen" });
  }

  for (const loaded of extensions.values()) {
    const listeners = loaded.events.get(event.event);
    if (listeners == null) {
      continue;
    }
    for (const listener of listeners) {
      try {
        listener(event.params);
      } catch (error) {
        log(loaded.payload.id, "error", ["a " + event.event + " listener threw", error]);
      }
    }
  }
}

async function handleMainRequest(request: {
  method: string;
  params: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  const args = (request.params ?? {}) as Record<string, unknown>;

  switch (request.method) {
    case "host.shutdown": {
      await Promise.all([...extensions.values()].map((loaded) => deactivate(loaded)));
      return null;
    }

    case "ai.invoke": {
      const extId = String(args.ext ?? "");
      const name = String(args.name ?? "");
      const loaded = extensions.get(extId);
      const handler = loaded?.tools.get(name);
      if (loaded == null || handler == null) {
        throw new RpcError("E_UNKNOWN_METHOD", "no extension offers a tool called `" + name + "`");
      }
      return (await handler(args.args, request.signal)) ?? null;
    }

    default:
      throw new RpcError("E_UNKNOWN_METHOD", "the extension host does not answer `" + request.method + "`");
  }
}

function handleMainEvent(event: { event: string; params: unknown }): void {
  const args = (event.params ?? {}) as Record<string, unknown>;

  if (event.event === "view.message") {
    const loaded = extensions.get(String(args.ext ?? ""));
    const listeners = loaded?.viewListeners.get(String(args.viewId ?? ""));
    for (const listener of listeners ?? []) {
      try {
        listener(args.message);
      } catch (error) {
        log(String(args.ext ?? ""), "error", ["a view message listener threw", error]);
      }
    }
    return;
  }

  if (event.event === "view.visible") {
    const loaded = extensions.get(String(args.ext ?? ""));
    if (loaded != null && args.visible === true) {
      void activate(loaded, "onView:" + String(args.viewId ?? ""));
    }
    return;
  }

  if (event.event === "config.changed") {
    const extId = String(args.ext ?? "");
    configs[extId] = (args.values ?? {}) as Record<string, string | number | boolean>;
    const loaded = extensions.get(extId);
    for (const listener of loaded?.events.get("config.changed") ?? []) {
      listener(args.values);
    }
    return;
  }

  if (event.event === "host.setEnabled") {
    const loaded = extensions.get(String(args.ext ?? ""));
    if (loaded != null && args.enabled === false) {
      void deactivate(loaded);
    }
    return;
  }
}

/** The highest port generation this host has accepted. See `host.ts`. */
let editorGeneration = 0;

function connectEditor(port: unknown, generation: number): void {
  // Older than what is already held. Two pairs are in flight on a first
  // launch, they arrive in whatever order the two channels deliver them, and
  // without this the host and the editor can end up holding one end each of
  // two different channels.
  if (generation < editorGeneration) {
    return;
  }
  editorGeneration = generation;

  editorEndpoint?.dispose("a newer editor connection replaced this one");
  editorReady = false;

  const endpoint = createRpcEndpoint(adaptPort(port), {
    request: handleEditorRequest,
    event: handleEditorEvent,
    close: () => {
      if (editorEndpoint === endpoint) {
        editorEndpoint = null;
        editorReady = false;
      }
    },
  });
  editorEndpoint = endpoint;

  void endpoint
    .request("host.hello", helloPayload(), { timeoutMs: LONG_TIMEOUT_MS })
    .then(() => {
      editorReady = true;
      // Startup extensions wake only once the editor has answered. Activating
      // before that would let an extension's first call reach a renderer that
      // has not installed its dispatch table, which fails as an unknown method
      // rather than as a wait.
      return trigger({ kind: "startup" });
    })
    .catch((error) => {
      // A superseded connection is the normal case, not a failure: two port
      // pairs are in flight on a first launch and the older one is disposed on
      // purpose. Only a real handshake failure is worth a line in the log the
      // user reads.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("a newer editor connection")) {
        return;
      }
      log("host", "error", ["the editor did not complete the handshake", error]);
    });
}

function connectMain(port: unknown): void {
  mainEndpoint = createRpcEndpoint(adaptPort(port), {
    request: handleMainRequest,
    event: handleMainEvent,
  });
}

parentPort.on("message", (message) => {
  const data = (message.data ?? {}) as {
    type?: string;
    extensions?: InitPayload[];
    configs?: never;
    dataRoot?: string;
    generation?: number;
  };

  if (data.type === "init") {
    connectMain(message.ports[0]);
    dataRoot = String(data.dataRoot ?? "");
    configs = (data.configs ?? {}) as typeof configs;
    installRequireHook();
    for (const payload of data.extensions ?? []) {
      loadPayload(payload);
    }
    void mainEndpoint?.request("host.ready", {}).catch(() => null);
    return;
  }

  if (data.type === "renderer-port") {
    connectEditor(message.ports[0], typeof data.generation === "number" ? data.generation : 0);
  }
});

/**
 * An extension's unhandled rejection must not take the host down.
 *
 * Without this, one `await` with no `catch` inside a third party's command
 * kills the process, every other extension with it, and the user sees the
 * whole extension system disappear because one author forgot a handler.
 */
process.on("unhandledRejection", (reason) => {
  log("host", "error", ["an extension left a promise rejection unhandled", reason]);
});

process.on("uncaughtException", (error) => {
  log("host", "error", ["an extension threw outside any call", error]);
});

void editorReady;
