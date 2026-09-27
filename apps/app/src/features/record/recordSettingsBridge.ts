/**
 * Reading the recorder's settings from the *editor*.
 *
 * The recorder engine owns these and persists them through
 * `electron-store`; the editor needs one field, `autoZoom`, at the moment a finished
 * take arrives. It cannot ask the engine, which may already be gone and which the
 * editor has never talked to, so it reads the same store main does.
 *
 * `normalizeRecordSettings` guards the read, so a store written by an older build or
 * edited by hand answers defaults rather than throwing in the middle of an import.
 */

import {
  DEFAULT_RECORD_SETTINGS,
  normalizeRecordSettings,
  type RecordSettings,
} from "./recordSettings";

export async function loadRecordSettings(): Promise<RecordSettings> {
  const api = (window as any).electronAPI?.req?.store;

  if (api?.get == null) {
    // The web build has no store, and no recorder to have written one.
    return DEFAULT_RECORD_SETTINGS;
  }

  try {
    // `store.get` answers a `{ status, value }` wrapper, not the value. Handing the
    // wrapper straight to `normalizeRecordSettings` is not an error: it is an object
    // with none of the fields it looks for, so it answers defaults, and the user's
    // Auto Zoom choice would be ignored on every take with nothing to show for it.
    // `apps/overlay-record/src/bridge.ts#loadSettings` unwraps it the same way.
    const result: any = await api.get("record");
    return normalizeRecordSettings(result?.status === 1 ? result.value : undefined);
  } catch (error) {
    console.warn("[record] could not read the recorder settings", error);
    return DEFAULT_RECORD_SETTINGS;
  }
}
