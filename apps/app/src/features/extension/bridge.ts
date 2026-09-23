/**
 * The editor's end of the extension host connection.
 *
 * Importing this module is what connects the editor to its extensions; the
 * side effect is the point, which is why `index.ts` imports it for effect only
 * and why it sits immediately after the agent bridge that does the same job
 * for Claude Code.
 *
 * ## The port arrives through the main world, not through `contextBridge`
 *
 * A `MessagePort` is a transferable, and `exposeInMainWorld` clones. So the
 * preload relays it with `window.postMessage` and a transfer list, and this
 * filters on `event.source === window`: a page cannot forge a message whose
 * source is the window it is running in, and nothing else in this app posts
 * with that type.
 *
 * ## Everything inbound is checked here
 *
 * The host is a separate process running code the app did not write. Every
 * request is checked for a method this table answers, for the extension it
 * claims to be, and for the permission that method needs, before anything
 * reaches a store. The RPC layer has already refused anything over the size
 * cap by the time a message gets here.
 */

import { getCommand, commandNames } from "../agent/registry";
import { ensureUndoBaseline } from "../agent/checkpoint";
import { useTimelineStore } from "../../states/timelineStore";
import { selectionStore } from "../../states/selectionStore";
import { timelineLockStore, isTimelineLocked, timelineLockMessage } from "../../states/timelineLockStore";
import { backgroundTaskStore } from "../../states/backgroundTaskStore";
import { windowStore } from "../window/windowStore";
import { windowScheduler } from "../caption/previewLoop";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { loadPresets, removePresetsOfExtension } from "../fx/presetRegistry";
import { refreshTemplateLibrary } from "../template/templateRegistry";
import { removeAnimationPresetsOf, setAnimationPresetsOf } from "./animationPresets";
import { contributionStore } from "./contributions";
import { setExportHookPorts } from "./exportHooks";
import { createDispatch, type DispatchPorts } from "./dispatch";
import { publishEditorEvents, type EventPublisher } from "./events";
import { hostStateStore } from "./hostState";
import {
  createRpcEndpoint,
  LONG_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RpcError,
  type PortLike,
  type RpcEndpoint,
} from "./shared";
import "./commands";

let endpoint: RpcEndpoint | null = null;
let events: EventPublisher | null = null;
let installed = false;
/** The highest port generation accepted. See `electron/extension/host.ts`. */
let portGeneration = 0;

/** The host's view of each extension's permissions, from the last hello. */
const permissions = new Map<string, string[]>();

function adaptMessagePort(port: MessagePort): PortLike {
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: (handler) => {
      port.onmessage = (event: MessageEvent) => handler(event.data);
    },
    // No `onClose`: a DOM `MessagePort` has no close event. A host that goes
    // away is learned from `ext:host:state` instead, which is the only signal
    // that actually exists for it.
    start: () => port.start(),
    close: () => port.close(),
  };
}

function toastMessage(text: string, kind: string): void {
  const box = document.querySelector("toast-box") as { showToast?: (options: unknown) => void } | null;
  // Optional twice over: the element may not be mounted yet during startup,
  // and an older build may not have the method. A failed toast must not turn
  // into a rejected extension call.
  if (typeof box?.showToast === "function") {
    box.showToast({ message: text, delay: kind === "error" ? "6000" : "3000" });
  }
}

function dispatchPorts(): DispatchPorts {
  return {
    runCommand: (name, params) => {
      const command = getCommand(name);
      if (command == null) {
        throw new RpcError("E_UNKNOWN_METHOD", "there is no editor command called `" + name + "`");
      }
      return command(params);
    },
    knownCommands: () => commandNames(),
    batchPorts: () => ({
      getDocument: () => useTimelineStore.getState().getDocument(),
      withCheckpoint: (fn) => useTimelineStore.getState().withCheckpoint(fn),
      ensureUndoBaseline,
      isLocked: isTimelineLocked,
      lockMessage: timelineLockMessage,
      runCommand: (name, params) => {
        const command = getCommand(name);
        if (command == null) {
          throw new Error("there is no editor command called `" + name + "`");
        }
        return command(params);
      },
    }),
    permissionsOf: (extId) => permissions.get(extId) ?? [],

    openPanel: (extId, viewId, placement) => {
      const key = extId + "/" + viewId;
      const view = contributionStore.getState().views.find((entry) => entry.key === key);
      if (view == null) {
        throw new RpcError("E_DECLINED", "`" + viewId + "` is not a view this extension contributes");
      }
      const request = (placement ?? {}) as Record<string, unknown>;
      windowStore.getState().open({
        id: "ext:" + key,
        hostId: "preview",
        placement:
          request.mode === "floating" && request.rect != null
            ? { mode: "floating", rect: request.rect as never }
            : {
                mode: "docked",
                side: (request.side as never) ?? "right",
                sizePct: typeof request.sizePct === "number" ? request.sizePct : 46,
              },
        closable: true,
      });
    },

    closePanel: (extId, viewId) => {
      windowStore.getState().close("ext:" + extId + "/" + viewId);
    },

    showMessage: toastMessage,

    setStatusItem: (item) => contributionStore.getState().setStatusItem(item),

    startTask: (extId, taskId, label, cancellable) => {
      backgroundTaskStore.getState().add({
        id: "ext:" + extId + ":" + taskId,
        kind: "extension",
        label,
        fraction: null,
        stage: "",
        icon: "extension",
        cancel: cancellable
          ? () => {
              // The host holds the AbortController; the row only asks.
              endpoint?.emit("task.cancelled:" + taskId, {}, extId);
            }
          : undefined,
      });
    },

    progressTask: (taskId, fraction, stage) => {
      for (const task of backgroundTaskStore.getState().tasks) {
        if (task.id.endsWith(":" + taskId)) {
          backgroundTaskStore.getState().progress(task.id, fraction, stage);
        }
      }
    },

    endTask: (taskId) => {
      for (const task of backgroundTaskStore.getState().tasks) {
        if (task.id.endsWith(":" + taskId)) {
          backgroundTaskStore.getState().remove(task.id);
        }
      }
    },

    projectInfo: () => {
      const command = getCommand("project_info");
      return command == null ? {} : command({});
    },
  };
}

function eventSources() {
  return {
    subscribeDocument: (listener: (elements: unknown, tracks: unknown) => void) => {
      let lastElements = useTimelineStore.getState().timeline;
      let lastTracks = useTimelineStore.getState().tracks;
      return useTimelineStore.subscribe((state) => {
        // Identity, not deep equality. The store already guarantees a new
        // object only when something changed, and a deep compare of every
        // element on every store write would cost more than the event.
        if (state.timeline === lastElements && state.tracks === lastTracks) {
          return;
        }
        lastElements = state.timeline;
        lastTracks = state.tracks;
        listener(state.timeline, state.tracks);
      });
    },
    subscribeCursor: (listener: (ms: number) => void) => {
      let last = useTimelineStore.getState().cursor;
      return useTimelineStore.subscribe((state) => {
        if (state.cursor === last) {
          return;
        }
        last = state.cursor;
        listener(state.cursor);
      });
    },
    subscribeSelection: (listener: (ids: string[]) => void) => {
      let last = selectionStore.getState().ids;
      return selectionStore.subscribe((state) => {
        if (state.ids === last) {
          return;
        }
        last = state.ids;
        listener(state.ids);
      });
    },
    subscribePlayback: (listener: (isPlay: boolean) => void) => {
      let last = useTimelineStore.getState().control.isPlay;
      return useTimelineStore.subscribe((state) => {
        if (state.control.isPlay === last) {
          return;
        }
        last = state.control.isPlay;
        listener(state.control.isPlay);
      });
    },
    subscribeLock: (listener: (reason: string | null) => void) => {
      let last = timelineLockStore.getState().reason;
      return timelineLockStore.subscribe((state) => {
        if (state.reason === last) {
          return;
        }
        last = state.reason;
        listener(state.reason);
      });
    },
    scheduler: windowScheduler(),
  };
}

function teardown(): void {
  events?.stop();
  events = null;
  endpoint?.dispose("the extension host went away");
  endpoint = null;
  setExportHookPorts(null);
  for (const extension of contributionStore.getState().extensions) {
    removePresetsOfExtension(extension.id);
    removeAnimationPresetsOf(extension.id);
  }
  void refreshTemplateLibrary();
  permissions.clear();
  contributionStore.getState().clear();
}

function connect(port: MessagePort): void {
  // A new port means a new host, or this page reloading. Either way whatever
  // was connected before is gone, and its subscriptions have to go with it.
  teardown();

  const dispatch = createDispatch(dispatchPorts());

  // The export hooks reach the host through this endpoint and know nothing
  // else about the transport, so `features/export/` never learns what a port
  // is and `exportHooks.ts` stays testable against a fake.
  setExportHookPorts({
    ask: (method, params, timeoutMs) => endpoint?.request(method, params, { timeoutMs }) ?? null,
  });

  endpoint = createRpcEndpoint(adaptMessagePort(port), {
    request: (request) => {
      if (request.method === "host.hello") {
        const params = (request.params ?? {}) as {
          protocolVersion?: number;
          extensions?: Array<{ id: string; permissions?: string[] }>;
        };
        if (params.protocolVersion !== PROTOCOL_VERSION) {
          throw new RpcError(
            "E_VERSION",
            "this editor speaks extension protocol " +
              PROTOCOL_VERSION +
              " and the host speaks " +
              String(params.protocolVersion),
          );
        }

        permissions.clear();
        for (const extension of params.extensions ?? []) {
          permissions.set(extension.id, extension.permissions ?? []);
        }
        const previous = new Set(contributionStore.getState().extensions.map((entry) => entry.id));
        contributionStore.getState().applyHello((params.extensions ?? []) as never);

        // An extension that went away takes its presets with it, and the set
        // may have changed either way, so the disk is re-read. Un-awaited
        // exactly as `App.ts` leaves `loadPresets`: a project referencing a
        // preset that has not arrived renders as a pass-through until it does.
        for (const id of previous) {
          if (!permissions.has(id)) {
            removePresetsOfExtension(id);
          }
        }
        void loadPresets();
        void loadDataContributions();
        // Templates evict themselves: `setTemplateLibrary` drops any parsed
        // document whose id is no longer in the listing, so a refresh after an
        // extension goes away is the whole of the unload.
        void refreshTemplateLibrary();

        events?.stop();
        events = publishEditorEvents(
          (event, eventParams) => endpoint?.emit(event, eventParams),
          eventSources(),
        );

        return { protocolVersion: PROTOCOL_VERSION };
      }

      return dispatch(request);
    },
  });
}

/**
 * Read the data files every loaded extension contributes.
 *
 * Asked of main rather than of the host, because main owns the directories and
 * because the host is the one process that should not be reading files on the
 * renderer's behalf. Un-awaited by the caller, exactly as `loadPresets` is: a
 * project referencing a contributed preset behaves as it does for any missing
 * preset until the list arrives.
 *
 * Never throws. A failure here costs the extension its presets, not the
 * editor's startup.
 */
async function loadDataContributions(): Promise<void> {
  try {
    const api = (window as never as { electronAPI?: { req?: { ext?: Record<string, Function> } } })
      .electronAPI?.req?.ext;
    const answer = (await api?.dataContributions?.()) as
      | {
          ok?: boolean;
          contributions?: Array<{
            extId: string;
            kind: string;
            files: Array<{ fileName: string; text: string }>;
            skipped: Array<{ fileName: string; reason: string }>;
          }>;
        }
      | undefined;

    if (answer?.ok !== true) {
      return;
    }

    for (const contribution of answer.contributions ?? []) {
      if (contribution.kind !== "animationPresets") {
        continue;
      }

      // Parsed here rather than in main, which has never read this format and
      // would need a second copy of the schema to. A file that is not JSON is
      // one bad file, reported and skipped.
      const parsed: Array<{ fileName: string; json: unknown }> = [];
      for (const file of contribution.files) {
        try {
          parsed.push({ fileName: file.fileName, json: JSON.parse(file.text) });
        } catch (error) {
          console.warn(
            "[extension] " + contribution.extId + "/" + file.fileName + ": " + String(error),
          );
        }
      }

      for (const failure of setAnimationPresetsOf(contribution.extId, parsed)) {
        console.warn(
          "[extension] " + contribution.extId + "/" + failure.fileName + ": " + failure.errors.join("; "),
        );
      }
      for (const skip of contribution.skipped) {
        console.warn("[extension] " + contribution.extId + "/" + skip.fileName + ": " + skip.reason);
      }
    }
  } catch (error) {
    console.warn("[extension] could not read data contributions", error);
  }
}

/**
 * Run one contributed command in the host.
 *
 * The single path from any surface the user can touch: a keybinding, a menu
 * item, a status item, the Extensions panel's search box. All of them end
 * here, so the activation, the timeout and the error toast are decided once.
 */
export async function runContributedCommand(
  extId: string,
  commandId: string,
  args?: unknown,
): Promise<unknown> {
  if (endpoint == null) {
    toastMessage("The extension host is not running.", "error");
    return null;
  }

  const contributed = contributionStore
    .getState()
    .commands.find((entry) => entry.extId === extId && entry.commandId === commandId);

  try {
    return await endpoint.request(
      "commands.invoke",
      { extId, command: commandId, args },
      { timeoutMs: contributed?.longRunning === true ? LONG_TIMEOUT_MS : undefined },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toastMessage((contributed?.title ?? commandId) + ": " + message, "error");
    return null;
  }
}

/** Tell the host something happened that one of its extensions asked to wake for. */
export function requestActivation(trigger: unknown): void {
  endpoint?.emit("activation.request", { trigger });
}

/** Whether an extension could be reached right now. */
export function isExtensionHostConnected(): boolean {
  return endpoint != null;
}

export function installExtensionBridge(): void {
  if (installed) {
    return;
  }
  // Electron only: in web and demo builds `ipcWrapper` stubs most of
  // `electronAPI` out and there is no main process to hand over a port.
  if (getLocationEnv() !== "electron") {
    return;
  }
  installed = true;

  window.addEventListener("message", (event: MessageEvent) => {
    // `event.source === window` is the check that matters. A page cannot forge
    // a message whose source is the window it is running in, so this cannot be
    // reached from content an extension rendered.
    if (event.source !== window || (event.data as { type?: string })?.type !== "ext:port") {
      return;
    }
    const generation = (event.data as { generation?: number }).generation ?? 0;
    // Older than what is already held. See `electron/extension/host.ts`: two
    // pairs are in flight on a first launch and the two ends must converge on
    // the same one or the handshake completes across two different channels.
    if (generation < portGeneration) {
      return;
    }
    portGeneration = generation;

    const port = event.ports?.[0];
    if (port != null) {
      connect(port);
    }
  });

  const api = (window as never as { electronAPI?: { res?: { ext?: Record<string, unknown> } } })
    .electronAPI?.res?.ext;
  if (api == null) {
    // An older preload. Better to run without extensions than to crash.
    console.warn("[extension] preload has no extension channel; the host is disabled");
    return;
  }

  (api.onHostState as (callback: (event: unknown, payload: unknown) => void) => void)(
    (_event, payload) => {
      const state = (payload ?? {}) as { state?: string; crashes?: number; lastError?: string | null };
      hostStateStore.getState().report(state.state ?? "idle", state.crashes ?? 0, state.lastError ?? null);

      // A host that is restarting or has given up has taken its contributions
      // with it. Leaving a panel or a status item on screen that nothing can
      // answer is worse than the gap.
      if (state.state !== "ready") {
        teardown();
      }
    },
  );
}

installExtensionBridge();
