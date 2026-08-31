/**
 * The installed presets, as one lookup.
 *
 * Loaded once at startup and held in a module-level map, the way the font
 * preset list is: the set only changes when someone installs something, and a
 * panel that re-read the disk on every render would stall the UI.
 *
 * The single rule that shapes this file: **built-in and user presets are
 * indistinguishable downstream.** They come from different directories and
 * carry different `origin` tags for display, and that is the entire difference.
 * Same loader, same validator, same failure modes. If a third-party preset were
 * going to break, a built-in one would break in the same place — which is the
 * only way to know the format actually works for anyone but us.
 *
 * The other rule is that **a missing preset is not an error state to handle
 * downstream.** `presetById` returns `null`, the compositor draws a
 * pass-through, and the panel shows a badge. The element keeps its `presetId`
 * and its `params` untouched, so opening a project on a machine without the
 * preset and saving it again loses nothing — the same shape of promise
 * `hierarchy.ts` makes about a `parentId` naming a deleted group.
 */

import { validatePreset } from "./presetValidate";
import {
  defaultParamsOf,
  type FxKind,
  type FxParamValues,
  type FxPreset,
  type RawPresetPayload,
} from "./presetTypes";

export { defaultParamsOf };
export type { FxPreset, FxParamValues };

/** Keyed by the manifest's `id`, not by folder name. */
let presets = new Map<string, FxPreset>();

/** One entry per folder that failed to validate, for the panel to surface. */
let failures: Array<{ id: string; dir: string; errors: string[] }> = [];

let loaded = false;

/**
 * Notified when the set of installed presets changes.
 *
 * The registry is module state, not a store, and that is fine for everything
 * that reads it in response to a click. It is not fine for the timeline: it
 * paints once at startup, well before `loadPresets` resolves, and an effect
 * clip's label comes from the preset's name. With nothing to tell it the
 * presets had arrived, every effect on the timeline showed its raw preset id
 * until some unrelated edit happened to trigger a repaint.
 *
 * A plain listener set rather than pulling in zustand: there is one event and
 * no state to read from it.
 */
const listeners = new Set<() => void>();

export function subscribePresets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // One bad subscriber must not stop the others from hearing about it.
      console.error("preset: listener failed", error);
    }
  }
}

/**
 * The preload bridge, or `undefined` where there is none.
 *
 * Reached through `globalThis` rather than `window` on purpose. A bare `window`
 * is a ReferenceError — not `undefined` — anywhere it is not declared, and
 * optional chaining does not save you from that: `window?.x` still throws if
 * `window` was never bound. Two places this actually runs have no `window`:
 * the `environment: "node"` test suites, and any future headless consumer.
 * Relying on the `try` below to swallow a ReferenceError works, but it makes
 * "no bridge here" indistinguishable from a real failure in the log.
 */
function presetBridge(): any {
  return (globalThis as any)?.electronAPI?.req?.preset;
}

/**
 * Read every preset folder and validate it.
 *
 * Safe to call more than once — a second call re-reads the disk, which is what
 * "Install preset…" needs after it copies a folder in.
 *
 * Never throws. A missing IPC bridge (the offscreen export window, a unit test)
 * leaves the registry empty rather than taking the caller down with it, and the
 * compositor renders every effect as a pass-through — visibly wrong, but not a
 * crash mid-export.
 */
export async function loadPresets(): Promise<void> {
  const nextPresets = new Map<string, FxPreset>();
  const nextFailures: typeof failures = [];

  let payloads: RawPresetPayload[] = [];
  try {
    const result = await presetBridge()?.list?.();
    payloads = Array.isArray(result?.presets) ? result.presets : [];
  } catch (error) {
    console.error("preset: could not enumerate presets", error);
    payloads = [];
  }

  for (const payload of payloads) {
    const result = validatePreset(payload);
    if (!result.ok) {
      nextFailures.push({
        id: payload.id,
        dir: payload.dir,
        errors: result.errors,
      });
      continue;
    }

    // Two folders claiming one id: first wins, and because built-ins are
    // enumerated first, a user preset cannot silently shadow one. Reported
    // rather than dropped, so the author can see why theirs did not appear.
    if (nextPresets.has(result.preset.id)) {
      nextFailures.push({
        id: payload.id,
        dir: payload.dir,
        errors: [
          "id `" +
            result.preset.id +
            "` is already used by another installed preset",
        ],
      });
      continue;
    }

    nextPresets.set(result.preset.id, result.preset);
  }

  presets = nextPresets;
  failures = nextFailures;
  loaded = true;

  for (const failure of nextFailures) {
    console.warn(
      "preset: skipped " + failure.dir + "\n  " + failure.errors.join("\n  "),
    );
  }

  notify();
}

/** Whether `loadPresets` has run. Distinguishes "none installed" from "not yet". */
export function presetsLoaded(): boolean {
  return loaded;
}

/** The preset with this id, or `null` when it is not installed. */
export function presetById(id: string): FxPreset | null {
  return presets.get(id) ?? null;
}

/** Everything of one kind, in display order. */
export function presetsOfKind(kind: FxKind): FxPreset[] {
  return [...presets.values()]
    .filter((preset) => preset.kind === kind)
    .sort(
      (a, b) =>
        // Built-ins first, then by name — so the panel opens on something
        // familiar rather than on whatever a user folder happened to be called.
        Number(a.origin === "user") - Number(b.origin === "user") ||
        a.name.localeCompare(b.name),
    );
}

/** Folders that did not validate, for a diagnostics view. */
export function presetFailures(): ReadonlyArray<{
  id: string;
  dir: string;
  errors: string[];
}> {
  return failures;
}

/**
 * The parameters a new element should start with.
 *
 * Falls back to an empty object for an unknown preset rather than throwing:
 * the user can pick a preset that is somehow not installed only through a
 * stale panel, and an element with no parameters renders as a pass-through,
 * which is the same outcome as every other missing-preset path.
 */
export function defaultParamsFor(presetId: string): FxParamValues {
  const preset = presetById(presetId);
  return preset == null ? {} : defaultParamsOf(preset);
}

/** Where the user should drop a preset folder. Creates it if it is not there. */
export async function userPresetDirectory(): Promise<string | null> {
  try {
    const result = await presetBridge()?.userDirectory?.();
    return typeof result?.path === "string" ? result.path : null;
  } catch (error) {
    console.error("preset: could not resolve the user preset directory", error);
    return null;
  }
}

/**
 * Replace the registry's contents directly.
 *
 * For tests and for the offscreen export window, which has no IPC bridge of its
 * own but is handed the same document the main window composited. Not part of
 * the normal path — `loadPresets` is.
 */
export function __setPresetsForTesting(list: FxPreset[]): void {
  presets = new Map(list.map((preset) => [preset.id, preset]));
  failures = [];
  loaded = true;
  notify();
}
