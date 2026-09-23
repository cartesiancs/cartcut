/**
 * The Extensions panel's half of the extension system.
 *
 * Everything the panel can do is here, and every one of them names an
 * extension by **id**, never by path. That is the rule `autosaveCache.ts`
 * states for the autosave directory and it matters more here: the renderer is
 * asking main to delete a folder, and a call shape that let it choose the
 * folder would be a remote delete primitive with a permission dialog in front
 * of it.
 */

import * as fsp from "fs/promises";
import { dialog, shell, type IpcMainInvokeEvent } from "electron";

import { extensionsRoot, isValidExtensionId } from "../extension/dirs";
import { installInspected, inspectArchive, uninstallExtension } from "../extension/installRuntime";
import { describePermission, isPermission } from "../extension/permissions";
import {
  extensionLog,
  hostSession,
  listExtensions,
  notifyConfigChanged,
  rescanExtensions,
  restartExtensionHost,
  setExtensionEnabled,
} from "../extension/host";
import {
  addUnpackedPath,
  isEnabled,
  removeUnpackedPath,
  setEnabled,
  unpackedPaths,
} from "../extension/settings";
import {
  coerceConfigValue,
  readStoredConfig,
  resolveConfig,
  writeStoredConfig,
  type ConfigSchema,
} from "../extension/config";
import { mainWindow } from "../lib/window";

/**
 * Every handler answers `{ ok }` rather than rejecting.
 *
 * The shape `ipcOverlayRecord.ts` settled on, for its reason: the panel has to
 * be able to tell "that is not an extension" from "the disk is full", and a
 * rejected `invoke` arrives as one opaque string with a stack from another
 * process pasted into it.
 */
type Answer<T> = ({ ok: true } & T) | { ok: false; error: string };

function failed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function configOf(id: string): Promise<Record<string, string | number | boolean>> {
  const listing = listExtensions().find((entry) => entry.id === id);
  const schema = ((listing?.configuration as { properties?: ConfigSchema } | null)?.properties ??
    {}) as ConfigSchema;
  return resolveConfig(schema, await readStoredConfig(id));
}

export const ipcExtensionHost = {
  list: async (): Promise<Answer<{ extensions: ReturnType<typeof listExtensions>; host: unknown }>> => {
    try {
      return { ok: true, extensions: await rescanExtensions(), host: hostSession() };
    } catch (error) {
      return failed(error);
    }
  },

  hostState: async () => ({ ok: true as const, host: hostSession() }),

  /**
   * Read an archive and report what it would install.
   *
   * Nothing is written. The panel shows the permissions this returns and asks;
   * only then does it call `install`. A user who declines must not already
   * have the extension on disk.
   */
  inspect: async (_event: IpcMainInvokeEvent, file: unknown) => {
    try {
      if (typeof file !== "string" || file === "") {
        return failed(new Error("no file was chosen"));
      }
      const result = await inspectArchive(file);
      if (!result.ok) {
        return failed(new Error(result.reason));
      }
      return {
        ok: true as const,
        id: result.manifest.id,
        displayName: result.manifest.displayName,
        version: result.manifest.version,
        description: result.manifest.description,
        permissions: result.manifest.permissions.map((permission) => ({
          id: permission,
          description: isPermission(permission) ? describePermission(permission) : permission,
        })),
        replaces: listExtensions().some((entry) => entry.id === result.manifest.id),
      };
    } catch (error) {
      return failed(error);
    }
  },

  install: async (_event: IpcMainInvokeEvent, file: unknown) => {
    try {
      if (typeof file !== "string" || file === "") {
        return failed(new Error("no file was chosen"));
      }
      const inspected = await inspectArchive(file);
      if (!inspected.ok) {
        return failed(new Error(inspected.reason));
      }
      const outcome = await installInspected(
        extensionsRoot(),
        inspected.manifest,
        inspected.files,
        inspected.bytes,
      );
      if (!outcome.ok) {
        return failed(new Error(outcome.reason));
      }
      restartExtensionHost();
      return { ok: true as const, id: outcome.id, replaced: outcome.replaced };
    } catch (error) {
      return failed(error);
    }
  },

  uninstall: async (_event: IpcMainInvokeEvent, id: unknown) => {
    try {
      if (!isValidExtensionId(id)) {
        return failed(new Error("that is not an extension id"));
      }
      const listing = listExtensions().find((entry) => entry.id === id);
      if (listing?.origin === "unpacked") {
        // An unpacked extension lives in the developer's own checkout. The
        // matching action is forgetting the path, not deleting their work.
        removeUnpackedPath(listing.dir);
      } else {
        await uninstallExtension(extensionsRoot(), id);
      }
      restartExtensionHost();
      return { ok: true as const };
    } catch (error) {
      return failed(error);
    }
  },

  setEnabled: async (_event: IpcMainInvokeEvent, id: unknown, enabled: unknown) => {
    try {
      if (!isValidExtensionId(id)) {
        return failed(new Error("that is not an extension id"));
      }
      const next = enabled === true;
      setEnabled(id, next);
      if (!next) {
        // Told first, so the extension gets to run `deactivate` before the
        // restart takes its process away.
        setExtensionEnabled(id, false);
      }
      restartExtensionHost();
      return { ok: true as const, enabled: isEnabled(id) };
    } catch (error) {
      return failed(error);
    }
  },

  loadUnpacked: async () => {
    try {
      const parent = mainWindow;
      const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
        properties: ["openDirectory"],
        title: "Choose an extension folder",
      });
      if (canceled || filePaths.length === 0) {
        return { ok: true as const, cancelled: true };
      }
      const dir = filePaths[0];
      try {
        await fsp.stat(dir + "/package.json");
      } catch {
        return failed(new Error("that folder has no package.json, so it is not an extension"));
      }
      addUnpackedPath(dir);
      restartExtensionHost();
      return { ok: true as const, cancelled: false, dir };
    } catch (error) {
      return failed(error);
    }
  },

  openFolder: async () => {
    try {
      const root = extensionsRoot();
      await fsp.mkdir(root, { recursive: true });
      await shell.openPath(root);
      return { ok: true as const, dir: root };
    } catch (error) {
      return failed(error);
    }
  },

  restart: async () => {
    restartExtensionHost();
    return { ok: true as const };
  },

  log: async (_event: IpcMainInvokeEvent, id: unknown) => {
    if (typeof id !== "string") {
      return failed(new Error("that is not an extension id"));
    }
    return { ok: true as const, lines: extensionLog(id) };
  },

  getConfig: async (_event: IpcMainInvokeEvent, id: unknown) => {
    try {
      if (!isValidExtensionId(id)) {
        return failed(new Error("that is not an extension id"));
      }
      return { ok: true as const, values: await configOf(id) };
    } catch (error) {
      return failed(error);
    }
  },

  setConfig: async (_event: IpcMainInvokeEvent, id: unknown, key: unknown, value: unknown) => {
    try {
      if (!isValidExtensionId(id) || typeof key !== "string") {
        return failed(new Error("that is not an extension setting"));
      }
      const listing = listExtensions().find((entry) => entry.id === id);
      const schema = ((listing?.configuration as { properties?: ConfigSchema } | null)?.properties ??
        {}) as ConfigSchema;
      const coerced = coerceConfigValue(schema, key, value);
      if (!coerced.ok) {
        return failed(new Error(coerced.reason));
      }
      const values = await configOf(id);
      values[key] = coerced.value;
      await writeStoredConfig(id, values);
      // The extension is told rather than having to poll, and it is told from
      // main because main is what just wrote the file.
      notifyConfigChanged(id, values);
      return { ok: true as const, values };
    } catch (error) {
      return failed(error);
    }
  },

  unpackedPaths: async () => ({ ok: true as const, paths: unpackedPaths() }),
};
