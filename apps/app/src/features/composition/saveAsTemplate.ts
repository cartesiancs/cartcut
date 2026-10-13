/**
 * "Save as Template…": a template the project owns, written out as a `.cttpl`
 * and installed in the user's library.
 *
 * The composition stays in the project, and the clips naming it keep naming
 * it: this saves a copy, separately, for other projects to place. The archive
 * is the one "Export Template" writes (`templateExport.ts`, the save dialog
 * naming it), and installing it is the one a picked `.cttpl` goes through
 * (`templateInstall.ts`).
 */

import { useTimelineStore } from "../../states/timelineStore";
import { contentOfState } from "../../states/timelineWorkspace";
import { serializeRenderOptions } from "../project/renderOptionsFile";
import { exportTemplate } from "../template/templateExport";
import {
  installTemplateArchive,
  templateIdFor,
} from "../template/templateInstall";
import {
  templateListing,
  type TemplateListing,
} from "../template/templateRegistry";
import { renderTemplateThumbnail } from "../template/templateThumbnail";
import { projectRenderOptions } from "./projectSnapshot";

export type SaveAsTemplateOutcome =
  | { ok: true; name: string; path: string; warnings: string[] }
  | { ok: false; message: string }
  | { ok: false; cancelled: true };

/**
 * The file name to install under, so the new template is not hidden.
 *
 * An id is the folder name and the first folder listed wins
 * (`templateRegistry#templateListing`); built-ins and extensions are listed
 * before the user's own. Saving "Lower Third" while a built-in `lower-third`
 * exists would install a template nobody could ever place, so the id gets a
 * suffix instead. A user template of the same id is replaced, which is what
 * re-importing one already does.
 */
export function installNameFor(
  destination: string,
  listingOf: (id: string) => Pick<TemplateListing, "origin"> | null = templateListing,
): string {
  const base = templateIdFor(destination);
  let id = base;
  for (let n = 2; ; n += 1) {
    const listed = listingOf(id);
    if (listed == null || listed.origin === "user") {
      return `${id}.cttpl`;
    }
    id = `${base}-${n}`;
  }
}

function readFileBridge(): ((path: string) => Promise<unknown>) | null {
  return (
    (globalThis as {
      electronAPI?: { req?: { filesystem?: { readFile?: (p: string) => Promise<unknown> } } };
    })?.electronAPI?.req?.filesystem?.readFile ?? null
  );
}

export async function saveCompositionAsTemplate(
  compositionId: string,
): Promise<SaveAsTemplateOutcome> {
  const state = useTimelineStore.getState();
  const meta = state.compositions[compositionId];
  const content = contentOfState(state, compositionId);
  if (meta == null || content == null) {
    return { ok: false, message: "That template is not in the project." };
  }

  // Its own frame, and the project's rate, colour and export choices.
  const options = { ...projectRenderOptions(), previewSize: { ...meta.size } };
  const atMs = state.activeTimelineId === compositionId ? state.cursor : 0;
  const thumbnail = await renderTemplateThumbnail(atMs, {
    elements: content.elements,
    size: meta.size,
  });

  const written = await exportTemplate({
    elements: content.elements,
    tracks: content.tracks,
    renderOptions: serializeRenderOptions(options, {
      previewRatio: 1,
      videoDestination: "",
    }),
    thumbnail,
  });
  if (!written.ok) {
    return written;
  }

  const read = readFileBridge();
  if (read == null) {
    return { ok: false, message: "The template was saved but could not be installed." };
  }
  let bytes: unknown;
  try {
    bytes = await read(written.path);
  } catch {
    bytes = null;
  }
  if (bytes == null) {
    return { ok: false, message: "The template was saved but could not be read back." };
  }
  const installed = await installTemplateArchive(installNameFor(written.path), bytes);
  if (!installed.ok) {
    return { ok: false, message: installed.message };
  }
  return {
    ok: true,
    name: written.name,
    path: written.path,
    warnings: written.warnings,
  };
}
