/**
 * What only main can do, done on an extension's behalf.
 *
 * Everything here needs a privilege the host does not have: a native dialog, a
 * keychain, the application menu, the path of a bundled binary. So these
 * methods travel on the main port rather than the direct one, and main answers
 * them against **the manifest main validated**, never against permissions the
 * host reported. That distinction is the point of the split: a bug or a
 * compromise in the host cannot widen what main will do for it.
 *
 * Nothing here reaches the editor. A service that needed the timeline would be
 * a second edit path, and there is exactly one (`commands.execute` on the
 * direct port, through `commit`).
 */

import * as fsp from "fs/promises";
import path from "path";
import { clipboard, dialog, safeStorage, shell } from "electron";

import { ffmpegConfig } from "../lib/ffmpeg";
import { extensionDataDir, storageFileFor } from "./dirs";
import {
  coerceConfigValue,
  readStoredConfig,
  resolveConfig,
  writeStoredConfig,
  type ConfigSchema,
} from "./config";
import { METHOD_PERMISSIONS, hasPermission, type Permission } from "./permissions";
import { RpcError, type InboundRequest } from "./rpc";
import type { ExtensionManifest } from "./manifest";
import type { LogLevel } from "./hostLog";

export type ContributedTool = {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
};

export type ServiceContext = {
  /** The validated manifest, or null when the host names an extension main does not know. */
  manifestOf(id: string): ExtensionManifest | null;
  log(id: string, level: LogLevel, text: string): void;
  onHostReady(): void;
  onExtensionState(id: string, phase: string, error: string | null): void;
  postToView(extId: string, viewId: string, message: unknown): void;
  setMenus(extId: string, items: unknown): void;
  registerTool(extId: string, tool: ContributedTool): void;
  unregisterTool(extId: string, name: string): void;
  /** The window a modal dialog belongs to. Null while the editor is gone. */
  dialogParent(): Electron.BrowserWindow | null;
};

function requireExt(request: InboundRequest): string {
  if (request.ext == null || request.ext === "") {
    throw new RpcError("E_INTERNAL", request.method + " arrived with no extension id");
  }
  return request.ext;
}

function schemaOf(manifest: ExtensionManifest | null): ConfigSchema {
  return (manifest?.contributes.configuration?.properties ?? {}) as ConfigSchema;
}

/**
 * Read a JSON file that an extension owns, or answer `{}`.
 *
 * Never throws for the reason `readStoredConfig` does not: these run inside an
 * extension's first few lines, and a corrupt file should cost the extension
 * its stored values rather than its ability to start.
 */
async function readJsonFile(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8")) as unknown;
    return parsed != null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const part = file + ".part";
  await fsp.writeFile(part, JSON.stringify(value, null, 2), "utf8");
  await fsp.rename(part, file);
}

function secretsFileFor(id: string): string {
  return path.join(extensionDataDir(id), "secrets.json");
}

export function createServiceHandlers(ctx: ServiceContext) {
  return async function handle(request: InboundRequest): Promise<unknown> {
    const { method, params } = request;
    const args = (params ?? {}) as Record<string, unknown>;

    // Lifecycle notices carry no extension of their own and gate on nothing.
    switch (method) {
      case "host.ready":
        ctx.onHostReady();
        return null;
      case "host.log": {
        const id = typeof args.ext === "string" ? args.ext : "host";
        ctx.log(id, (args.level as LogLevel) ?? "info", String(args.text ?? ""));
        return null;
      }
      case "host.extensionState": {
        ctx.onExtensionState(
          String(args.ext ?? ""),
          String(args.phase ?? ""),
          args.error == null ? null : String(args.error),
        );
        return null;
      }
      default:
        break;
    }

    const extId = requireExt(request);
    const manifest = ctx.manifestOf(extId);
    if (manifest == null) {
      throw new RpcError("E_PERMISSION", "`" + extId + "` is not an extension this app loaded");
    }

    // The gate, against main's own copy of the manifest. Reading the
    // permission from the request would let the host grant itself anything.
    const needed: Permission | undefined = METHOD_PERMISSIONS[method];
    if (needed != null && !hasPermission(manifest.permissions, needed)) {
      throw new RpcError(
        "E_PERMISSION",
        method + " needs the `" + needed + "` permission, which " + extId + " did not ask for",
      );
    }

    switch (method) {
      case "paths.ffmpeg":
        return ffmpegConfig.FFMPEG_PATH;

      case "paths.ffprobe":
        return ffmpegConfig.FFPROBE_PATH;

      case "shell.open": {
        const target = String(args.target ?? "");
        // Only a URL with a scheme the OS opens, or a path. `openExternal` on
        // an arbitrary string is how a `file://` to an installer becomes a
        // double click nobody made.
        if (/^https?:\/\//.test(target)) {
          await shell.openExternal(target);
          return null;
        }
        await shell.openPath(target);
        return null;
      }

      case "assets.reveal":
        shell.showItemInFolder(String(args.path ?? ""));
        return null;

      case "window.showOpenDialog": {
        const parent = ctx.dialogParent();
        if (parent == null) {
          throw new RpcError("E_INTERNAL", "there is no window to open a dialog on");
        }
        const properties: Array<"openFile" | "openDirectory" | "multiSelections"> =
          args.directory === true ? ["openDirectory"] : ["openFile"];
        if (args.multiple === true) {
          properties.push("multiSelections");
        }
        const extensions = Array.isArray(args.extensions)
          ? args.extensions.filter((value): value is string => typeof value === "string")
          : ["*"];
        const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
          properties,
          filters: [{ name: "File", extensions }],
        });
        return canceled ? [] : filePaths;
      }

      case "window.showSaveDialog": {
        const parent = ctx.dialogParent();
        if (parent == null) {
          throw new RpcError("E_INTERNAL", "there is no window to open a dialog on");
        }
        const extensions = Array.isArray(args.extensions)
          ? args.extensions.filter((value): value is string => typeof value === "string")
          : ["*"];
        const { canceled, filePath } = await dialog.showSaveDialog(parent, {
          defaultPath: typeof args.defaultName === "string" ? args.defaultName : undefined,
          filters: [{ name: "File", extensions }],
        });
        return canceled ? null : filePath;
      }

      case "config.get": {
        const values = resolveConfig(schemaOf(manifest), await readStoredConfig(extId));
        const key = args.key;
        return typeof key === "string" ? (values[key] ?? null) : values;
      }

      case "config.set": {
        const schema = schemaOf(manifest);
        const key = String(args.key ?? "");
        const coerced = coerceConfigValue(schema, key, args.value);
        if (!coerced.ok) {
          throw new RpcError("E_DECLINED", coerced.reason);
        }
        const values = resolveConfig(schema, await readStoredConfig(extId));
        values[key] = coerced.value;
        await writeStoredConfig(extId, values);
        return values;
      }

      case "storage.get": {
        const stored = await readJsonFile(storageFileFor(extId));
        const key = String(args.key ?? "");
        return key in stored ? stored[key] : null;
      }

      case "storage.set": {
        const stored = await readJsonFile(storageFileFor(extId));
        stored[String(args.key ?? "")] = args.value as never;
        await writeJsonFile(storageFileFor(extId), stored);
        return null;
      }

      case "storage.delete": {
        const stored = await readJsonFile(storageFileFor(extId));
        delete stored[String(args.key ?? "")];
        await writeJsonFile(storageFileFor(extId), stored);
        return null;
      }

      case "secrets.get":
      case "secrets.set":
      case "secrets.delete": {
        // Refuse rather than fall back to plaintext. A user who granted
        // `secrets` was told it goes in the system keychain, and a silent
        // downgrade to a readable file in `userData` would make that false.
        if (!safeStorage.isEncryptionAvailable()) {
          throw new RpcError(
            "E_INTERNAL",
            "this system has no secure storage available, so secrets cannot be kept",
          );
        }
        const file = secretsFileFor(extId);
        const stored = await readJsonFile(file);
        const key = String(args.key ?? "");

        if (method === "secrets.get") {
          const encoded = stored[key];
          if (typeof encoded !== "string") {
            return null;
          }
          try {
            return safeStorage.decryptString(Buffer.from(encoded, "base64"));
          } catch {
            // A keychain entry written by a different install, or a profile
            // copied between machines. Absent is the honest answer.
            return null;
          }
        }

        if (method === "secrets.set") {
          stored[key] = safeStorage.encryptString(String(args.value ?? "")).toString("base64");
        } else {
          delete stored[key];
        }
        await writeJsonFile(file, stored);
        return null;
      }

      case "clipboard.read":
        if (!hasPermission(manifest.permissions, "clipboard")) {
          throw new RpcError("E_PERMISSION", "clipboard access needs the `clipboard` permission");
        }
        return clipboard.readText();

      case "clipboard.write":
        if (!hasPermission(manifest.permissions, "clipboard")) {
          throw new RpcError("E_PERMISSION", "clipboard access needs the `clipboard` permission");
        }
        clipboard.writeText(String(args.text ?? ""));
        return null;

      case "view.post":
        ctx.postToView(extId, String(args.viewId ?? ""), args.message);
        return null;

      case "menus.set":
        ctx.setMenus(extId, args.items);
        return null;

      case "ai.registerTool": {
        const name = String(args.name ?? "");
        const description = String(args.description ?? "");
        if (name === "" || description === "") {
          throw new RpcError("E_DECLINED", "a tool needs a name and a description");
        }
        ctx.registerTool(extId, {
          name,
          description,
          inputSchema: (args.inputSchema ?? undefined) as Record<string, unknown> | undefined,
        });
        return null;
      }

      case "ai.unregisterTool":
        ctx.unregisterTool(extId, String(args.name ?? ""));
        return null;

      default:
        throw new RpcError("E_UNKNOWN_METHOD", "main does not answer `" + method + "`");
    }
  };
}
