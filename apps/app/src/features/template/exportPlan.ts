/**
 * What writing a `.cttpl` involves, decided before anything touches the disk.
 *
 * Export takes the project as it stands and produces a folder that answers for
 * itself on someone else's machine: `template.ngt` at the root, every file it
 * refers to staged under `assets/`, and the paths inside the `.ngt` pointing at
 * the staged copies. Zipping that folder is the whole of the format.
 *
 * The trick is that **nothing here invents a path format**. The elements are
 * rewritten to absolute paths *inside the staging folder*, and then
 * `project.ts`'s ordinary save runs against `<staging>/template.ngt` — so
 * `serializeAssetPaths` sees assets sitting beside the project it is writing
 * and records `assets/clip.mp4` in `assetPaths.json` exactly as it would for a
 * portable project. `relinkAssets` then resolves them on install. Both halves
 * of the round trip are code that already existed and is already tested; this
 * module only has to put the files where that code expects them.
 *
 * Pure, so the naming rules below can be pinned without a filesystem. The
 * caller copies the files and writes the archive.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import {
  detectFlavour,
  mintLocalPath,
  shapeOf,
  toFsPath,
  type PathFlavour,
} from "../project/assetPaths";
import { assetFieldsOf, type AssetField } from "../project/assetsFile";

/** One file to copy into the archive. */
export type StagedAsset = {
  /** Where it is now, as a filesystem path. */
  from: string;
  /** Its name inside the archive, POSIX-separated, always under `assets/`. */
  entry: string;
  /** The `localpath` every element naming it must be rewritten to. */
  localpath: string;
};

export type TemplateExportPlan =
  | {
      ok: true;
      assets: StagedAsset[];
      /** The document to save as `template.ngt`, paths already restaged. */
      elements: Timeline;
      /** Things the author should know, none of them fatal. */
      warnings: string[];
    }
  | { ok: false; reason: string };

export type TemplateExportOptions = {
  /** The folder the archive is being built in. Absolute, host syntax. */
  stagingDir: string;
  flavour?: PathFlavour;
};

const ASSET_DIR = "assets";

/**
 * A filename safe to put in a zip and then on any filesystem.
 *
 * Everything outside a conservative set becomes `-`, because an entry name is
 * about to be a path on a machine whose rules we do not know: a colon is fatal
 * on Windows, a slash is a separator everywhere, and a leading dot hides the
 * file on Unix. The extension is kept because `mime.ts#lookup` is what decides
 * an imported file's kind and it reads the last dot-segment.
 */
export function safeAssetName(name: string): string {
  const cleaned = name
    // Control characters, spelled as escapes: a literal one in a source
    // file survives no editor, no diff and no copy-paste.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^\.+/, "")
    .replace(/-+/g, "-");
  return cleaned === "" || cleaned === "." ? "asset" : cleaned;
}

function basename(fsPath: string): string {
  return fsPath.split(/[\\/]/).pop() ?? "";
}

/** `a.mp4` -> `a-2.mp4`, keeping the extension where a reader looks for it. */
function withSuffix(name: string, index: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return `${name}-${index}`;
  }
  return `${name.slice(0, dot)}-${index}${name.slice(dot)}`;
}

/**
 * Whether this value names a file worth staging.
 *
 * Mirrors `assetsFile.ts#isRealAssetPath`, which is module-private there. The
 * duplication is deliberate rather than a widened export: that predicate guards
 * what goes into `assetPaths.json` and this one guards what goes into an
 * archive, and coupling them would mean a change to either reaching the other.
 */
function isRealAssetPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    !/^(https?|blob|data):/i.test(value)
  );
}

/**
 * Everything a `.cttpl` for this project would contain.
 *
 * Refuses a document holding a template of its own: nesting is capped at one
 * level, and refusing here is the half of that cap someone can act on —
 * `composeTemplate` strips a nested template silently because by then there is
 * nobody to tell.
 */
export function planTemplateExport(
  elements: Timeline,
  options: TemplateExportOptions,
): TemplateExportPlan {
  const nested = Object.keys(elements).filter(
    (id) => elements[id]?.filetype === "template",
  );
  if (nested.length > 0) {
    return {
      ok: false,
      reason:
        "A template cannot contain another template. Remove the template clips and export again.",
    };
  }

  const flavour = options.flavour ?? detectFlavour(options.stagingDir);
  const stagingFs = toFsPath(options.stagingDir, flavour);
  const separator = flavour === "win32" ? "\\" : "/";
  const trimmed = stagingFs.replace(/[\\/]+$/, "");

  const staged = new Map<string, StagedAsset>();
  const taken = new Set<string>();
  const next: Record<string, TimelineElement> = {};

  // Key order, so an archive built twice from one project is byte-identical:
  // collision suffixes depend on the order names are claimed in.
  for (const id of Object.keys(elements).sort()) {
    const element = elements[id];
    if (element == null || typeof element !== "object") {
      continue;
    }

    let rewritten: TimelineElement | null = null;

    for (const field of assetFieldsOf(element)) {
      const value = (element as Record<string, unknown>)[field];
      if (!isRealAssetPath(value)) {
        continue;
      }

      let asset = staged.get(value);
      if (asset == null) {
        const from = toFsPath(value, flavour);
        let name = safeAssetName(basename(from));
        // One file used by two clips is staged once. Two *different* files
        // that share a basename each get their own name.
        for (let index = 2; taken.has(name.toLowerCase()); index += 1) {
          name = withSuffix(safeAssetName(basename(from)), index);
        }
        taken.add(name.toLowerCase());

        asset = {
          from,
          entry: `${ASSET_DIR}/${name}`,
          // Minted in the same shape the original had, so an element that
          // carried a bare path still carries one. `mergeOps` compares these
          // strings to decide two clips share a source.
          localpath: mintLocalPath(
            `${trimmed}${separator}${ASSET_DIR}${separator}${name}`,
            shapeOf(value),
          ),
        };
        staged.set(value, asset);
      }

      rewritten = {
        ...(rewritten ?? element),
        [field satisfies AssetField]: asset.localpath,
      } as TimelineElement;
    }

    next[id] = rewritten ?? element;
  }

  const warnings: string[] = [];
  const fx = Object.keys(elements).filter(
    (id) =>
      elements[id]?.filetype === "effect" ||
      elements[id]?.filetype === "transition",
  );
  if (fx.length > 0) {
    warnings.push(
      `${fx.length} effect or transition ${
        fx.length === 1 ? "clip" : "clips"
      } will not render inside a template.`,
    );
  }

  return {
    ok: true,
    assets: [...staged.values()],
    elements: next as Timeline,
    warnings,
  };
}

/** Every slot the exported template will offer, for the confirmation dialog. */
export function exportSlotCount(elements: Timeline): number {
  const ids = new Set<string>();
  for (const element of Object.values(elements)) {
    const slotId = (element as { replaceable?: { slotId?: unknown } })
      ?.replaceable?.slotId;
    if (typeof slotId === "string" && slotId !== "") {
      ids.add(slotId);
    }
  }
  return ids.size;
}
