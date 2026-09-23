/**
 * What the editor does when an extension asks for something.
 *
 * One table, one gate, and no path to the document that is not
 * `features/agent/registry.ts`. That last part is the whole point: an
 * extension's edit runs the same function a Claude Code tool call runs, so it
 * lands in one `withCheckpoint`, respects the caption-session lock, is
 * whitelisted on the way in by `commands/writable.ts` and on the way out by
 * `serialize.ts`, and appears in the undo history as one step the user can
 * reject.
 *
 * Pure over `DispatchPorts` so the table can be exercised without a store, a
 * port or a window, which is the rule `features/timeline/` follows and the
 * only way there is to test any of this: there is no DOM test environment
 * here.
 */

import { RpcError } from "./shared";
import { currentExtensionOwner, withExtensionOwner } from "./commands";
import { NON_TRANSACTIONAL, runBatch, type BatchPorts, type BatchStep } from "./transaction";
import type { ContributedStatusItem } from "./contributions";

/**
 * Commands that only read.
 *
 * A closed list, and everything absent from it counts as mutating. That
 * direction is deliberate: a command added later is assumed to change the
 * timeline until somebody decides otherwise, so the failure of forgetting this
 * file is an extension being asked for a permission it does not need, rather
 * than an extension editing without one.
 */
export const READ_ONLY_COMMANDS = new Set([
  "ping",
  "get_project_overview",
  "list_clips",
  "get_clip",
  "get_keyframes",
  "get_selection",
  "get_fx",
  "get_transcript_source",
  "list_assets",
  "list_cuts",
  "project_info",
  "ext_get_element_data",
  "ext_get_project_data",
]);

export type DispatchPorts = {
  runCommand(name: string, params: unknown): unknown;
  knownCommands(): string[];
  batchPorts(): BatchPorts;
  /** The permissions the host reported for this extension, from the hello. */
  permissionsOf(extId: string): string[];
  openPanel(extId: string, viewId: string, placement: unknown): void;
  closePanel(extId: string, viewId: string): void;
  showMessage(text: string, kind: string): void;
  setStatusItem(item: ContributedStatusItem | { extId: string; itemId: string; remove: true }): void;
  startTask(extId: string, taskId: string, label: string, cancellable: boolean): void;
  progressTask(taskId: string, fraction: number | null, stage: string): void;
  endTask(taskId: string): void;
  projectInfo(): unknown;
};

function requireExt(ext: string | undefined, method: string): string {
  if (ext == null || ext === "") {
    throw new RpcError("E_INTERNAL", method + " arrived with no extension id");
  }
  return ext;
}

function gate(ports: DispatchPorts, extId: string, commandName: string): void {
  if (READ_ONLY_COMMANDS.has(commandName)) {
    return;
  }
  if (!ports.permissionsOf(extId).includes("timeline.write")) {
    throw new RpcError(
      "E_PERMISSION",
      "`" + commandName + "` changes the project, which needs the `timeline.write` permission.",
    );
  }
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function createDispatch(ports: DispatchPorts) {
  return function dispatch(request: { method: string; params: unknown; ext?: string }): unknown {
    const args = (request.params ?? {}) as Record<string, unknown>;

    switch (request.method) {
      case "commands.list":
        return { commands: ports.knownCommands() };

      case "commands.execute": {
        const extId = requireExt(request.ext, request.method);
        const name = str(args.name);
        if (name === "") {
          throw new RpcError("E_UNKNOWN_METHOD", "commands.execute needs a command name");
        }
        gate(ports, extId, name);
        // The owner is set around the call rather than passed in, so that a
        // command which stores data writes under the extension that asked and
        // cannot be told to write under another.
        return withExtensionOwner(extId, () => ports.runCommand(name, args.params ?? {}));
      }

      case "commands.batch": {
        const extId = requireExt(request.ext, request.method);
        const steps = (Array.isArray(args.steps) ? args.steps : []) as BatchStep[];
        for (const step of steps) {
          const name = str((step as { name?: unknown })?.name);
          if (name === "") {
            throw new RpcError("E_DECLINED", "every step in a batch needs a command name");
          }
          if (NON_TRANSACTIONAL.has(name)) {
            throw new RpcError("E_DECLINED", "`" + name + "` cannot run inside a batch");
          }
          gate(ports, extId, name);
        }
        return withExtensionOwner(extId, () => runBatch(steps, ports.batchPorts()));
      }

      case "project.info":
        return ports.projectInfo();

      case "project.getData": {
        const extId = requireExt(request.ext, request.method);
        return withExtensionOwner(extId, () => ports.runCommand("ext_get_project_data", {}));
      }

      case "project.setData": {
        const extId = requireExt(request.ext, request.method);
        if (!ports.permissionsOf(extId).includes("project.write")) {
          throw new RpcError(
            "E_PERMISSION",
            "storing data in the project needs the `project.write` permission.",
          );
        }
        return withExtensionOwner(extId, () =>
          ports.runCommand("ext_set_project_data", { value: args.value ?? null }),
        );
      }

      case "window.showPanel": {
        const extId = requireExt(request.ext, request.method);
        ports.openPanel(extId, str(args.viewId), args.placement);
        return null;
      }

      case "window.closePanel": {
        const extId = requireExt(request.ext, request.method);
        ports.closePanel(extId, str(args.viewId));
        return null;
      }

      case "window.showMessage": {
        requireExt(request.ext, request.method);
        ports.showMessage(str(args.text).slice(0, 500), str(args.kind, "info"));
        return null;
      }

      case "window.setStatusItem": {
        const extId = requireExt(request.ext, request.method);
        const itemId = str(args.id);
        if (itemId === "") {
          throw new RpcError("E_DECLINED", "a status item needs an id");
        }
        if (args.remove === true) {
          ports.setStatusItem({ extId, itemId, remove: true });
          return null;
        }
        ports.setStatusItem({
          key: extId + "/" + itemId,
          extId,
          itemId,
          alignment: args.alignment === "left" ? "left" : "right",
          priority: typeof args.priority === "number" ? args.priority : 0,
          text: str(args.text).slice(0, 120),
          tooltip: args.tooltip == null ? null : str(args.tooltip).slice(0, 300),
          commandId: args.command == null ? null : str(args.command),
        });
        return null;
      }

      case "task.start": {
        const extId = requireExt(request.ext, request.method);
        ports.startTask(extId, str(args.taskId), str(args.label, "Working"), args.cancellable === true);
        return null;
      }

      case "task.progress": {
        requireExt(request.ext, request.method);
        const fraction = typeof args.fraction === "number" ? args.fraction : null;
        ports.progressTask(str(args.taskId), fraction, str(args.stage));
        return null;
      }

      case "task.end": {
        requireExt(request.ext, request.method);
        ports.endTask(str(args.taskId));
        return null;
      }

      default:
        throw new RpcError(
          "E_UNKNOWN_METHOD",
          "the editor does not answer `" + request.method + "`",
        );
    }
  };
}

export { currentExtensionOwner };
