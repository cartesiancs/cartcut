/**
 * Letting an extension speak before and after an export.
 *
 * Two hooks, and they are not the same kind of thing.
 *
 * **`onWillExport` can stop the export.** It runs after the user has picked a
 * destination and before any work begins, and an extension may veto with a
 * reason the user is shown. That is the point: an extension that knows the
 * project is not ready, because a caption is untranslated or an asset is a
 * proxy, can say so at the one moment it still costs nothing.
 *
 * **`onDidExport` cannot.** The file is written; it is a notification.
 *
 * ## The veto is bounded, and silence means yes
 *
 * An export that waited indefinitely on a stranger's promise would be an
 * export a broken extension could make impossible, with no way out but
 * quitting. So the ask has a timeout, and a host that does not answer in time
 * is treated as having no objection. An extension loses its veto by being
 * slow; the user does not lose their export.
 */

import { LONG_TIMEOUT_MS } from "./shared";

/** How long every extension together gets to object. */
export const WILL_EXPORT_TIMEOUT_MS = 10_000;

export type ExportVeto = { extId: string; reason: string };

export type WillExportAnswer = {
  /** Empty when nothing objected, which includes nothing being asked. */
  vetoes: ExportVeto[];
};

/**
 * What the host answers with.
 *
 * One entry per listener, in no particular order, and most of them `null`.
 * Reading it defensively rather than trusting the shape is the same rule
 * `contributions.ts` follows: it arrives from another process, and a throw on
 * this path would take the export with it.
 */
export function readVetoes(answer: unknown): ExportVeto[] {
  if (!Array.isArray(answer)) {
    return [];
  }
  const vetoes: ExportVeto[] = [];
  for (const entry of answer) {
    if (entry == null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const reason = record.veto;
    if (typeof reason !== "string" || reason.trim() === "") {
      continue;
    }
    vetoes.push({
      extId: typeof record.extId === "string" ? record.extId : "an extension",
      // Capped: this ends up in a toast, and a stranger's string is not a
      // paragraph the user asked to read.
      reason: reason.trim().slice(0, 300),
    });
  }
  return vetoes;
}

/** The sentence the user is shown when an export is stopped. */
export function vetoMessage(vetoes: readonly ExportVeto[]): string {
  if (vetoes.length === 0) {
    return "";
  }
  if (vetoes.length === 1) {
    return vetoes[0].reason;
  }
  return vetoes.map((veto) => veto.reason).join(" ");
}

type HookPorts = {
  /** Asks every extension, or null when no host is connected. */
  ask(method: string, params: unknown, timeoutMs: number): Promise<unknown> | null;
};

let ports: HookPorts | null = null;

/** Set by `bridge.ts`, so this module needs no knowledge of the transport. */
export function setExportHookPorts(next: HookPorts | null): void {
  ports = next;
}

/**
 * Ask before exporting. Resolves to whatever objected.
 *
 * Never rejects. A host that is not running, times out, or errors is a host
 * with no objection: the export is the user's, and an extension's silence
 * cannot be read as a refusal.
 */
export async function askWillExport(settings: unknown): Promise<WillExportAnswer> {
  const pending = ports?.ask("export.willExport", { settings }, WILL_EXPORT_TIMEOUT_MS);
  if (pending == null) {
    return { vetoes: [] };
  }
  try {
    return { vetoes: readVetoes(await pending) };
  } catch {
    return { vetoes: [] };
  }
}

/** Tell every extension the file was written. Fire and forget. */
export function announceDidExport(path: string, settings: unknown): void {
  // `LONG_TIMEOUT_MS` rather than the short one: an export target may be
  // uploading the file, and a rejected promise nobody reads would still log.
  void ports?.ask("export.didExport", { path, settings }, LONG_TIMEOUT_MS)?.catch(() => null);
}
