/**
 * Where cloud content lives on disk. Plain `path`, no Electron.
 *
 * ```
 * userData/cloud/presets/<id>/    scanned by preset:list as origin "cloud"
 * userData/cloud/templates/<id>/  scanned by template:list as origin "cloud"
 * userData/cloud/assets/<id>/     media, listed by cloud:installedAssets
 * userData/cloud/staging/         downloads in flight; scanned by nothing
 * ```
 *
 * Staging sits **outside** every scanned root. The preset scanner reads any
 * folder holding a `manifest.json` as a preset, so a `presets/<id>.part/`
 * would show a half-downloaded preset to the next `loadPresets`.
 */

import path from "path";

export type CloudKind = "effect" | "transition" | "graphic" | "lut" | "template" | "asset";

export const CLOUD_KINDS: readonly CloudKind[] = [
  "effect",
  "transition",
  "graphic",
  "lut",
  "template",
  "asset",
];

export function isCloudKind(value: unknown): value is CloudKind {
  return typeof value === "string" && (CLOUD_KINDS as readonly string[]).includes(value);
}

/** Effects, transitions, graphics and LUTs are all presets to the app. */
export function isPresetKind(kind: CloudKind): boolean {
  return kind !== "template" && kind !== "asset";
}

export function cloudRoot(userData: string): string {
  return path.join(userData, "cloud");
}

export function cloudPresetRoot(userData: string): string {
  return path.join(cloudRoot(userData), "presets");
}

export function cloudTemplateRoot(userData: string): string {
  return path.join(cloudRoot(userData), "templates");
}

export function cloudAssetRoot(userData: string): string {
  return path.join(cloudRoot(userData), "assets");
}

export function cloudStagingRoot(userData: string): string {
  return path.join(cloudRoot(userData), "staging");
}

/** The folder one kind installs into. */
export function installRootFor(userData: string, kind: CloudKind): string {
  if (kind === "template") {
    return cloudTemplateRoot(userData);
  }
  if (kind === "asset") {
    return cloudAssetRoot(userData);
  }
  return cloudPresetRoot(userData);
}
