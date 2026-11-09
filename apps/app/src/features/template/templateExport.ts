/**
 * Writing a `.cttpl`.
 *
 * The plan — which files to stage, what to call them, and what the document's
 * paths become — is `exportPlan.ts`, pure and tested. This is the half that
 * touches disk: read each asset, build the archive, ask where to put it.
 *
 * **Nothing here invents a path format.** The archive is built with the staged
 * copies at `assets/…` and the `.ngt`'s `assetPaths.json` written by the very
 * same `serializeAssetPaths` a project save uses, anchored on
 * `<staging>/template.ngt`. On install, `relinkAssets` resolves those relatives
 * against the extracted folder. Both halves of the round trip already existed;
 * `exportPlan.test.ts` pins that this module's staging keeps them agreeing.
 *
 * The archive is assembled entirely in memory rather than in a real staging
 * directory: JSZip is building one anyway, and a temp folder would need
 * creating, populating and — the part that always goes wrong — removing on
 * every failure path. `stagingDir` is therefore a *notional* anchor, and only
 * ever used as a string for the path arithmetic.
 */

import JSZip from "jszip";
import type { Timeline } from "../../@types/timeline";
import { arrayBufferToBase64 } from "../../utils/base64";
import { serializeAssetPaths } from "../project/assetsFile";
import { schemaVersionFor, type TimelineTrack } from "../timeline/tracks";
import { planTemplateExport } from "./exportPlan";
import { isBrowserBuild, getLocationEnv } from "../../functions/getLocationEnv";
import { mediaUrlFor } from "../../functions/mediaUrl";
import { registeredMedia } from "../asset/webMedia/mediaRegistry";

/**
 * One staged asset's bytes. A browser's own pick is read from the `File` it
 * stands for, and a site or server path is fetched; the desktop reads its
 * disk through the bridge.
 */
async function readAsset(from: string, fs: FilesystemBridge | null): Promise<unknown> {
  if (from.startsWith("blob:")) {
    const media = registeredMedia(from);
    return media == null ? null : new Uint8Array(await media.file.arrayBuffer());
  }
  if (isBrowserBuild()) {
    const response = await fetch(mediaUrlFor(from, getLocationEnv()));
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  }
  return fs?.readFile == null ? null : fs.readFile(from);
}

/** The notional folder the archive is anchored on. Never created. */
const STAGING_DIR = "/cartcut-template";
const NGT_NAME = "template.ngt";

export type TemplateExportInput = {
  elements: Timeline;
  tracks: TimelineTrack[];
  /** As `serializeRenderOptions` would produce for a project save. */
  renderOptions: unknown;
  name: string;
  author?: string;
  /** PNG bytes for `thumbnail.png`, when one could be rendered. */
  thumbnail?: Uint8Array | null;
};

/** Everything `exportTemplate` needs except the name, which it derives. */
export type TemplateExportRequest = Omit<TemplateExportInput, "name" | "thumbnail"> & {
  /**
   * The thumbnail, or a render of it run only once the destination is chosen:
   * a browser's save picker needs the click's user activation, which a render
   * awaited first could outlast.
   */
  thumbnail?: Uint8Array | null | (() => Promise<Uint8Array | null>);
};

async function resolved(request: TemplateExportRequest): Promise<Omit<TemplateExportInput, "name">> {
  const thumbnail = typeof request.thumbnail === "function" ? await request.thumbnail() : request.thumbnail;
  return { ...request, thumbnail: thumbnail ?? null };
}

export type TemplateExportResult =
  | { ok: true; path: string; name: string; warnings: string[] }
  | { ok: false; message: string }
  | { ok: false; cancelled: true };

/**
 * The template's name, taken from the file the user chose to save it as.
 *
 * **There is no separate name prompt, and there must not be one.**
 * `window.prompt` throws outright in Electron ("prompt() is and will not be
 * supported"), and asking twice for one thing would be wrong even where it
 * works: the save dialog already makes the user type a name, and a template
 * called something other than its own filename is a thing nobody can find
 * again.
 */
export function templateNameFrom(destination: string): string {
  const base = (destination.split(/[\\/]/).pop() ?? destination).replace(
    /\.cttpl$/i,
    "",
  );
  const trimmed = base.trim();
  return trimmed === "" ? "Template" : trimmed;
}

type FilesystemBridge = {
  readFile?: (path: string) => Promise<unknown>;
  /** See `ipcFilesystem.writeFileEnsured`: awaited, and it reports failure. */
  writeFileEnsured?: (
    path: string,
    base64: string,
  ) => Promise<{ status: boolean; error?: string }>;
};

function filesystem(): FilesystemBridge | null {
  return (
    (globalThis as { electronAPI?: { req?: { filesystem?: FilesystemBridge } } })
      ?.electronAPI?.req?.filesystem ?? null
  );
}

/**
 * Build the archive, without asking where it goes.
 *
 * Separated from `exportTemplate` so the assembly can be driven from a test or
 * from anywhere that already knows the destination.
 */
export async function buildTemplateArchive(
  input: TemplateExportInput,
): Promise<
  { ok: true; blob: Blob; warnings: string[] } | { ok: false; message: string }
> {
  const browser = isBrowserBuild();
  const plan = planTemplateExport(input.elements, {
    stagingDir: STAGING_DIR,
    flavour: "posix",
    // A browser's own picks are files too, read from the `File` they stand for.
    ...(browser ? { browserMedia: (path: string) => registeredMedia(path)?.name ?? null } : {}),
  });
  if (!plan.ok) {
    return { ok: false, message: plan.reason };
  }

  const fs = filesystem();
  if (!browser && fs?.readFile == null) {
    return { ok: false, message: "No filesystem bridge is available." };
  }

  const zip = new JSZip();

  // Every asset, read once. A file that cannot be read fails the whole export
  // rather than producing an archive with a hole in it: a template missing one
  // clip looks like a template, and the person who receives it has no way to
  // know what was supposed to be there.
  for (const asset of plan.assets) {
    let bytes: unknown;
    try {
      bytes = await readAsset(asset.from, fs);
    } catch {
      bytes = null;
    }
    if (bytes == null) {
      return {
        ok: false,
        message: `Could not read ${asset.from}. Relink it and export again.`,
      };
    }
    zip.file(asset.entry, bytes as never);
  }

  // The document, written exactly as a project save writes one — including
  // `assetPaths.json`, anchored on where the `.ngt` sits inside the archive.
  // That anchoring is the whole of the format's portability.
  const ngt = new JSZip();
  ngt.file(
    "project.json",
    JSON.stringify({ schemaVersion: schemaVersionFor(plan.elements as any) }),
  );
  ngt.file("timeline.json", JSON.stringify(plan.elements));
  ngt.file("tracks.json", JSON.stringify(input.tracks));
  ngt.file("renderOptions.json", JSON.stringify(input.renderOptions));
  ngt.file(
    "assetPaths.json",
    JSON.stringify(
      serializeAssetPaths(
        plan.elements as Record<string, never>,
        `${STAGING_DIR}/${NGT_NAME}`,
      ),
    ),
  );

  zip.file(NGT_NAME, await ngt.generateAsync({ type: "uint8array" }));

  // Presentation only. The slot list is deliberately absent: `slotsOf` derives
  // it from the document, so a copy here would be a second answer that drifts.
  zip.file(
    "template.json",
    JSON.stringify({
      name: input.name,
      ...(input.author == null || input.author === ""
        ? {}
        : { author: input.author }),
      ...(input.thumbnail == null ? {} : { thumbnail: "thumbnail.png" }),
    }),
  );

  if (input.thumbnail != null) {
    zip.file("thumbnail.png", input.thumbnail);
  }

  return {
    ok: true,
    blob: await zip.generateAsync({ type: "blob" }),
    warnings: plan.warnings,
  };
}

/**
 * Ask where the template goes, then build it and write it.
 *
 * **Asking first is deliberate.** The name comes from the file the user chose
 * — see `templateNameFrom` — so the dialog has to come before the build; and
 * building first meant reading every asset in the project only to discover the
 * user had cancelled, which on a real project is seconds of work thrown away.
 */
export async function exportTemplate(
  request: TemplateExportRequest,
): Promise<TemplateExportResult> {
  if (isBrowserBuild()) {
    return exportTemplateInBrowser(request);
  }
  const dialog = (
    globalThis as {
      electronAPI?: {
        req?: { dialog?: { saveTemplate?: () => Promise<string | undefined> } };
      };
    }
  )?.electronAPI?.req?.dialog;
  if (dialog?.saveTemplate == null) {
    return { ok: false, message: "No file dialog is available." };
  }

  const destination = await dialog.saveTemplate();
  // Cancelling is not a failure, and must not be reported as one — the
  // distinction `pickAndImportLut` draws with its `null`.
  if (destination == null || destination === "") {
    return { ok: false, cancelled: true };
  }

  const name = templateNameFrom(destination);
  const built = await buildTemplateArchive({ ...(await resolved(request)), name });
  if (!built.ok) {
    return built;
  }

  const fs = filesystem();
  if (fs?.writeFileEnsured == null) {
    return { ok: false, message: "No filesystem bridge is available." };
  }

  // Awaited and checked. The older `writeFile` resolves before the bytes reach
  // disk and reports a failure as a success — which is exactly how the first
  // version of this reported a template it had not written.
  const written = await fs.writeFileEnsured(
    destination,
    arrayBufferToBase64(await built.blob.arrayBuffer()),
  );
  if (!written.status) {
    return {
      ok: false,
      message: `The template could not be written: ${written.error ?? destination}`,
    };
  }

  return { ok: true, path: destination, name, warnings: built.warnings };
}

/**
 * The browser's Export Template: the save picker, or a download under a name
 * the user gives, then the same archive the desktop writes.
 */
async function exportTemplateInBrowser(
  request: TemplateExportRequest,
): Promise<TemplateExportResult> {
  const { chooseFileTarget, writeTarget } = await import("../project/web/webProjectFile");
  const target = await chooseFileTarget("Template.cttpl", {
    types: [{ description: "CartCut Template", accept: { "application/zip": [".cttpl"] } }],
    request: {
      title: "Export Template",
      note: "This browser saves the template as a download.",
      extensions: [".cttpl"],
    },
  });
  if (target == null) {
    return { ok: false, cancelled: true };
  }

  const name = templateNameFrom(target.name);
  const built = await buildTemplateArchive({ ...(await resolved(request)), name });
  if (!built.ok) {
    return built;
  }
  const written = await writeTarget(target, built.blob);
  if (!written.ok) {
    return { ok: false, message: written.message };
  }
  return { ok: true, path: target.name, name, warnings: built.warnings };
}
