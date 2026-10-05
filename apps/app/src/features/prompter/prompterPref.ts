/**
 * The prompter's speed, remembered between openings and between launches.
 *
 * `localStorage` for the reason `asset/assetSortPref.ts` gives: the value has
 * to be there synchronously when the panel is built, and an IPC read would land
 * after the first paint with the readout already showing the default.
 *
 * Every read and write may throw (site data blocked, no storage at all, vitest
 * under node), and every one of them means "use the default", never a crash.
 */

import { DEFAULT_PROMPTER_SPEED, coerceSpeed } from "./prompterScroll";

export const PROMPTER_SPEED_STORAGE_KEY = "cartcut.prompterSpeed";

export type PrompterStoragePort = {
  read(): string | null;
  write(value: string): void;
};

export function loadPrompterSpeed(port: PrompterStoragePort): number {
  try {
    const raw = port.read();
    return raw == null ? DEFAULT_PROMPTER_SPEED : coerceSpeed(JSON.parse(raw));
  } catch {
    return DEFAULT_PROMPTER_SPEED;
  }
}

export function savePrompterSpeed(
  port: PrompterStoragePort,
  speed: number,
): void {
  try {
    port.write(JSON.stringify(coerceSpeed(speed)));
  } catch {
    // The speed still holds for this session; it just will not outlive it.
  }
}

/** The real one. `localStorage` is looked up at each call, never at import. */
export const browserPrompterStorage: PrompterStoragePort = {
  read: () =>
    globalThis.localStorage?.getItem(PROMPTER_SPEED_STORAGE_KEY) ?? null,
  write: (value) =>
    globalThis.localStorage?.setItem(PROMPTER_SPEED_STORAGE_KEY, value),
};
