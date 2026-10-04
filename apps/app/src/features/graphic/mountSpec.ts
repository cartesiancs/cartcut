/**
 * An HTML preset turned into what the host mounts: sanitised nodes, a filtered
 * and renamed stylesheet, hoisted `@property` rules, and resolved assets.
 *
 * Remembered per preset object, so a graphic on screen for ten seconds is
 * sanitised once. Installed presets and inline programs go through the same
 * path, because a hand-edited `.ngt` or a downloaded preset is no more trusted
 * than an agent's draft: the read side sanitises again whatever the write side
 * stored (plan section 8).
 */

import type { FxHtmlRender, FxPreset } from "../fx/presetTypes";
import { digest64 } from "../project/projectDigest";
import { stableStringify } from "../fx/programHash";
import type { Diagnostic } from "../fx/inlineProgram";
import {
  filterStylesheet,
  renameCustomProperties,
} from "./cssFilter";
import { fileUrlOf } from "./fileUrl";
import type { MountSpec } from "./htmlRasterPort";
import { sanitizeHtml } from "./sanitizeHtml";

export type BuiltMount = { spec: MountSpec; removed: Diagnostic[] };

const built = new WeakMap<FxPreset, BuiltMount>();

/** Every `asset:<name>` reference in CSS, quoted or not, replaced with its URL. */
function resolveCssAssets(css: string, urls: Record<string, string>): string {
  return css.replace(/url\(\s*(["']?)asset:([^"')\s]+)\1\s*\)/g, (whole, _q, name) => {
    const url = urls[name];
    return url == null ? "none" : `url(${JSON.stringify(url)})`;
  });
}

export function mountSpecOf(preset: FxPreset): BuiltMount | null {
  if (preset.render.type !== "html") {
    return null;
  }
  const known = built.get(preset);
  if (known != null) {
    return known;
  }
  const render = preset.render as FxHtmlRender;
  const assetNames = new Set(Object.keys(preset.assets ?? {}));
  const assetUrls: Record<string, string> = {};
  for (const [name, path] of Object.entries(preset.assets ?? {})) {
    assetUrls[name] = fileUrlOf(path);
  }

  const removed: Diagnostic[] = [];
  const markup = sanitizeHtml(preset.sources[render.source] ?? "", {
    assetNames,
    file: render.source,
  });
  removed.push(...markup.removed);

  let css = "";
  let propertyRules = "";
  const names: string[] = [];
  for (const sheet of render.styles ?? []) {
    const filtered = filterStylesheet(preset.sources[sheet] ?? "", { assetNames, file: sheet });
    removed.push(...filtered.removed);
    css += filtered.css + "\n";
    propertyRules += filtered.propertyRules + "\n";
    names.push(...filtered.propertyNames);
  }

  const contentHash = digest64(stableStringify({ r: render, s: preset.sources, a: preset.assets }));
  // Registered properties are document-global (`@property` is ignored inside a
  // shadow root, measured), so each program's names get its own prefix and two
  // graphics that both register `--angle` cannot overwrite each other's.
  const prefix = "--g" + contentHash.slice(0, 8) + "-";
  const renames: Record<string, string> = {};
  for (const name of names) {
    renames[name] = prefix + name.slice(2);
  }
  const renamedCss = renameCustomProperties(resolveCssAssets(css, assetUrls), names, prefix);
  const renamedRules = renameCustomProperties(propertyRules, names, prefix);

  const spec: MountSpec = {
    programKey: preset.id + "@" + contentHash,
    nodes: markup.nodes,
    css: renamedCss,
    propertyRules: renamedRules,
    renames,
    assetUrls,
    programHash: contentHash,
  };
  const result = { spec, removed };
  built.set(preset, result);
  return result;
}
