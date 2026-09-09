/**
 * Installing a `.cttpl`: unzip it into `userData/templates/<id>/`.
 *
 * This lives in the renderer, not in `electron/lib/template.ts`, and the reason
 * is the same one that keeps preset *validation* on this side: the rule that
 * decides what a template is — `archive.ts`'s "`template.ngt` at the root, or
 * this is not a template" — belongs with the code that understands the format,
 * and main would need a second copy of it plus a second zip library to apply
 * it. Here JSZip is already loaded for `functions/project.ts`.
 *
 * The order is load-bearing and is the one `lut/lutImport.ts` settled on:
 * **read, then validate, then write.** Nothing reaches the disk until the
 * archive has been proved to be a template, so a rejected file leaves no
 * half-installed folder behind for the scanner to find.
 */

import JSZip from "jszip";
import { readArchiveLayout } from "./archive";
import {
  refreshTemplateLibrary,
  templateListing,
  type TemplateListing,
} from "./templateRegistry";

export type TemplateInstallResult =
  | { ok: true; id: string; name: string; listing: TemplateListing }
  | { ok: false; message: string };

type FilesystemBridge = {
  readFile?: (path: string) => Promise<unknown>;
  /**
   * The awaited, directory-creating, failure-reporting write.
   *
   * Not `writeFile`: that one calls the callback form of `fs.writeFile` and
   * returns before it runs, so a failure is indistinguishable from success —
   * and it does not create `assets/`, which every template needs.
   */
  writeFileEnsured?: (
    path: string,
    base64: string,
  ) => Promise<{ status: boolean; error?: string }>;
};

function filesystem(): FilesystemBridge | null {
  const api = (
    globalThis as {
      electronAPI?: { req?: { filesystem?: FilesystemBridge } };
    }
  )?.electronAPI?.req?.filesystem;
  return api ?? null;
}

async function userTemplateDirectory(): Promise<string | null> {
  const api = (
    globalThis as {
      electronAPI?: {
        req?: { template?: { userDirectory?: () => Promise<{ path: string }> } };
      };
    }
  )?.electronAPI?.req?.template;
  if (api?.userDirectory == null) {
    return null;
  }
  try {
    return (await api.userDirectory()).path;
  } catch {
    return null;
  }
}

/**
 * A folder name for this archive.
 *
 * The same shape `lutInstall.ts#planLutInstall` produces, and with the same
 * two rules: it must be one path segment, and a second import of the same name
 * **replaces** the first rather than piling up `neon-2`, `neon-3` — re-importing
 * is overwhelmingly "I fixed that template", not "I want both".
 */
export function templateIdFor(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).replace(
    /\.cttpl$/i,
    "",
  );
  const cleaned = base
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+/g, "-")
    .slice(0, 64);
  return cleaned === "" ? "template" : cleaned;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Install one `.cttpl` from bytes.
 *
 * `fileName` decides the folder, and therefore the id; the archive's own
 * `template.json` decides the display name.
 */
export async function installTemplateArchive(
  fileName: string,
  bytes: unknown,
): Promise<TemplateInstallResult> {
  const fs = filesystem();
  if (fs?.writeFileEnsured == null) {
    return { ok: false, message: "No filesystem bridge is available." };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes as never);
  } catch {
    return { ok: false, message: "That file is not a zip archive." };
  }

  // Validate before writing anything. A rejected archive must leave nothing
  // behind for the scanner to find.
  const names: string[] = [];
  zip.forEach((relativePath, file) => {
    if (!file.dir) {
      names.push(relativePath);
    }
  });

  const layout = readArchiveLayout(names);
  if (!layout.ok) {
    return { ok: false, message: layout.reason };
  }

  const root = await userTemplateDirectory();
  if (root == null) {
    return { ok: false, message: "No template folder is available." };
  }

  const id = templateIdFor(fileName);
  const dir = `${root.replace(/\/+$/, "")}/${id}`;

  const wanted = [
    layout.ngt,
    ...(layout.manifest == null ? [] : [layout.manifest]),
    ...(layout.thumbnail == null ? [] : [layout.thumbnail]),
    ...layout.assets,
  ];

  try {
    for (const name of wanted) {
      const file = zip.file(name);
      if (file == null) {
        continue;
      }
      const content = await file.async("uint8array");
      // Entry names are already POSIX and already proved safe by
      // `readArchiveLayout` — no `..`, no absolute, no backslash — so joining
      // them onto the install root cannot escape it.
      const target = `${dir}/${name.replace(/^\.\//, "")}`;
      const written = await fs.writeFileEnsured(target, toBase64(content));
      if (!written.status) {
        return {
          ok: false,
          message: `The template could not be written: ${written.error ?? target}`,
        };
      }
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `The template could not be written: ${error.message}`
          : "The template could not be written.",
    };
  }

  await refreshTemplateLibrary();

  const listing = templateListing(id);
  if (listing == null) {
    return {
      ok: false,
      message: "The template was written but could not be read back.",
    };
  }
  return { ok: true, id, name: listing.name, listing };
}

/** Read a `.cttpl` off disk and install it. */
export async function installTemplateFromPath(
  fsPath: string,
): Promise<TemplateInstallResult> {
  const fs = filesystem();
  if (fs?.readFile == null) {
    return { ok: false, message: "No filesystem bridge is available." };
  }
  let bytes: unknown;
  try {
    bytes = await fs.readFile(fsPath);
  } catch {
    return { ok: false, message: "That template could not be read." };
  }
  if (bytes == null) {
    return { ok: false, message: "That template could not be read." };
  }
  return installTemplateArchive(fsPath, bytes);
}

/**
 * Ask for a `.cttpl` and install it.
 *
 * Answers `null` when the dialog was cancelled, which the caller must not
 * report as a failure — the distinction `pickAndImportLut` also draws.
 */
export async function pickAndInstallTemplate(): Promise<TemplateInstallResult | null> {
  const dialog = (
    globalThis as {
      electronAPI?: {
        req?: {
          dialog?: { openFile?: (ext: string[]) => Promise<string | undefined> };
        };
      };
    }
  )?.electronAPI?.req?.dialog;
  if (dialog?.openFile == null) {
    return { ok: false, message: "No file dialog is available." };
  }

  const chosen = await dialog.openFile(["cttpl"]);
  if (chosen == null || chosen === "") {
    return null;
  }
  return installTemplateFromPath(chosen);
}

/** Remove an installed template, then re-read the library. */
export async function removeTemplate(
  id: string,
): Promise<{ ok: boolean; reason?: string }> {
  const api = (
    globalThis as {
      electronAPI?: {
        req?: {
          template?: {
            remove?: (id: string) => Promise<{ ok: boolean; reason?: string }>;
          };
        };
      };
    }
  )?.electronAPI?.req?.template;
  if (api?.remove == null) {
    return { ok: false, reason: "No template bridge is available." };
  }
  const result = await api.remove(id);
  await refreshTemplateLibrary();
  return result;
}
